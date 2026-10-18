/* Edge Function "geocode": transforma as coordenadas da selfie em endereço (OpenCage).
 *
 * Por que existe: a chave do OpenCage não pode ficar no navegador (qualquer pessoa copiaria
 * e gastaria a cota). Aqui ela fica como segredo do Supabase (OPENCAGE_API_KEY).
 *
 * Regras:
 *  - Só atende operador logado. A chave "anon" sozinha não basta: o token enviado precisa
 *    pertencer a um usuário de verdade.
 *  - Recebe só o id da solicitação, nunca coordenadas. As coordenadas são lidas do banco,
 *    com a permissão do próprio operador (RLS): ele só consegue geocodificar solicitações dele.
 *  - O endereço é guardado na linha. Cada solicitação consulta o OpenCage no máximo uma vez
 *    com sucesso, o que protege a cota (teste grátis: 2.500 por dia e 1 por segundo).
 *  - "no_record=1": pede ao OpenCage para não registrar a consulta (as coordenadas são
 *    dados pessoais do cliente).
 *
 * Variáveis usadas (SUPABASE_URL e SUPABASE_ANON_KEY já existem nas Edge Functions):
 *   OPENCAGE_API_KEY  -> você cadastra em Edge Functions > Secrets
 */
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resposta(corpo: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const erro = (codigo: string, mensagem: string, status: number) =>
  resposta({ error: codigo, mensagem }, status);

// O Supabase está migrando os nomes das chaves injetadas nas funções:
// SUPABASE_ANON_KEY (legado) -> SUPABASE_PUBLISHABLE_KEYS (JSON com a entrada "default").
function chavePublica(): string {
  const legada = Deno.env.get("SUPABASE_ANON_KEY");
  if (legada) return legada;
  try {
    const dic = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
    return String(dic.default ?? Object.values(dic)[0] ?? "");
  } catch {
    return "";
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return erro("metodo", "Use POST.", 405);

  // 1) Quem chama é um operador logado?
  const autorizacao = req.headers.get("Authorization") ?? "";
  if (!/^bearer\s+\S+/i.test(autorizacao)) {
    return erro("nao_autenticado", "Faça login no painel para consultar o endereço.", 401);
  }
  const jwt = autorizacao.replace(/^bearer\s+/i, "").trim();

  const chave_publica = chavePublica();
  if (!Deno.env.get("SUPABASE_URL") || !chave_publica) {
    return erro("nao_configurado", "A função não recebeu a URL e a chave do projeto.", 500);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, chave_publica, {
    // As consultas ao banco usam o token do operador, então a RLS vale como se ele mesmo consultasse
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: sessao, error: erroSessao } = await supabase.auth.getUser(jwt);
  if (erroSessao || !sessao?.user) {
    return erro("nao_autenticado", "Sessão inválida ou expirada. Entre de novo no painel.", 401);
  }

  // 2) Qual solicitação?
  let id: unknown = null;
  try {
    id = (await req.json())?.id;
  } catch {
    // corpo vazio ou inválido: cai na validação abaixo
  }
  if (typeof id !== "string" || !UUID.test(id)) {
    return erro("id_invalido", "Identificador da solicitação inválido.", 400);
  }

  // 3) Lê as coordenadas (a RLS só devolve a linha se for do operador)
  const { data: linha, error: erroLeitura } = await supabase
    .from("solicitacoes")
    .select("latitude, longitude, endereco")
    .eq("id", id)
    .maybeSingle();
  if (erroLeitura) {
    console.error("Falha ao ler a solicitação:", erroLeitura.message);
    return erro("banco", "Não foi possível ler a solicitação.", 500);
  }
  if (!linha) return erro("nao_encontrada", "Solicitação não encontrada.", 404);

  if (linha.endereco) return resposta({ endereco: linha.endereco, cached: true });

  if (linha.latitude === null || linha.longitude === null) {
    return erro("sem_localizacao", "Esta solicitação não tem localização registrada.", 409);
  }

  // 4) Consulta o OpenCage
  const chave = Deno.env.get("OPENCAGE_API_KEY");
  if (!chave) {
    return erro("nao_configurado", "A chave do OpenCage ainda não foi cadastrada nos segredos do Supabase.", 503);
  }

  const url = new URL("https://api.opencagedata.com/geocode/v1/json");
  url.searchParams.set("q", `${linha.latitude},${linha.longitude}`);
  url.searchParams.set("key", chave);
  url.searchParams.set("language", "pt-BR");
  url.searchParams.set("no_annotations", "1");
  url.searchParams.set("no_record", "1");
  url.searchParams.set("limit", "1");

  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    // Registra só o tipo do erro: a URL da requisição contém a chave
    console.error("OpenCage inacessível:", e instanceof Error ? e.name : "erro");
    return erro("opencage_indisponivel", "O serviço de endereços não respondeu. Tente de novo em instantes.", 502);
  }

  if (resp.status === 401 || resp.status === 403) {
    return erro("opencage_chave", "O OpenCage recusou a chave. Confira o segredo OPENCAGE_API_KEY.", 502);
  }
  if (resp.status === 402) {
    return erro("opencage_cota", "A cota diária do OpenCage acabou. Tente amanhã ou contrate um plano.", 502);
  }
  if (resp.status === 429) {
    return erro("opencage_limite", "Muitas consultas seguidas ao OpenCage. Aguarde um instante.", 502);
  }
  if (!resp.ok) {
    console.error("OpenCage respondeu com status", resp.status);
    return erro("opencage_erro", "O serviço de endereços retornou um erro.", 502);
  }

  let corpo: { results?: Array<{ formatted?: string }> };
  try {
    corpo = await resp.json();
  } catch {
    return erro("opencage_erro", "Resposta inesperada do serviço de endereços.", 502);
  }

  const formatado = corpo?.results?.[0]?.formatted;
  if (typeof formatado !== "string" || !formatado.trim()) {
    return resposta({ endereco: null, mensagem: "Nenhum endereço encontrado para essas coordenadas." });
  }
  const endereco = formatado.trim().slice(0, 300);

  // 5) Guarda o endereço (se falhar, ainda devolve o resultado)
  const { error: erroGravacao } = await supabase
    .from("solicitacoes")
    .update({ endereco })
    .eq("id", id);
  if (erroGravacao) console.error("Não foi possível guardar o endereço:", erroGravacao.message);

  return resposta({ endereco, cached: false });
});
