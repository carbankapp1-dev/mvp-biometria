/* Página do cliente: abre o link, aceita o termo, faz a selfie e envia.
 * Não há login. O token do link é o único segredo; o banco só deixa este token
 * consultar o próprio status e enviar UMA selfie (veja supabase.sql).
 * A comparação com o documento NÃO acontece aqui: é feita no painel do operador.
 */

const $ = (id) => document.getElementById(id);
const cfg = window.APP_CONFIG || {};
const SECOES = ["carregando", "erro", "consentimento", "etapaSelfie", "finalizado"];

let client = null;
let token = null;
let local = null; // { latitude, longitude, precisao } obtida logo antes da selfie

const el = {
  video: $("video"), overlay: $("overlay"), instrucao: $("instrucao"), debug: $("debug"),
  btnIniciar: $("btnIniciar"), passoVirar: $("passoVirar"), passoFrente: $("passoFrente"),
};

function marcar(item, estado) {
  item.classList.remove("ok", "atual");
  if (estado) item.classList.add(estado);
}

const ui = {
  instrucao: (t) => { el.instrucao.textContent = t; },
  debug: (t) => { el.debug.textContent = t; },
  passo: (nome, estado) => marcar(nome === "virar" ? el.passoVirar : el.passoFrente, estado),
};

function mostrar(secao) {
  for (const s of SECOES) $(s).hidden = s !== secao;
}

function erro(mensagem) {
  $("erroTexto").textContent = mensagem;
  mostrar("erro");
}

/* ---------- inicialização: valida o link ---------- */
async function init() {
  // Rótulo de versão no rodapé: se não aparecer (ou for antigo), o navegador está com arquivos velhos
  const rotuloVersao = $("versao");
  if (rotuloVersao) rotuloVersao.textContent = "v" + (SelfieCore.VERSAO || "antiga");

  token = new URLSearchParams(location.search).get("t");
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    return erro("Link inválido. Peça um novo link a quem enviou este.");
  }
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes("SEU-PROJETO")) {
    return erro("O sistema ainda não foi configurado (config.js).");
  }

  // persistSession:false -> ignora qualquer login de operador guardado neste navegador,
  // para que o cliente (e testes feitos pelo operador) sempre usem o papel anônimo.
  client = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data, error: err } = await client.rpc("obter_solicitacao", { p_token: token });
  if (err) return erro("Não foi possível verificar o link. Tente novamente em instantes.");
  const s = Array.isArray(data) ? data[0] : data;
  if (!s) return erro("Link inválido ou não encontrado.");
  if (s.status !== "pendente") {
    return erro("Esta verificação já foi concluída. Se precisar refazer, peça um novo link.");
  }
  if (s.expirada) return erro("Este link expirou. Peça um novo link a quem enviou este.");

  if (s.nome_cliente) $("saudacao").textContent = `Olá, ${s.nome_cliente}!`;
  if (cfg.EMPRESA_NOME) $("empresa").textContent = cfg.EMPRESA_NOME;
  mostrar("consentimento");
}

$("chkConsent").addEventListener("change", (e) => {
  $("btnContinuar").disabled = !e.target.checked;
});
$("btnContinuar").addEventListener("click", () => mostrar("etapaSelfie"));

/* ---------- selfie ---------- */
// Erro com texto pronto para o cliente (amigavel) e um detalhe técnico para quem for investigar.
function erroEnvio(amigavel, detalhe) {
  const e = new Error(amigavel);
  e.amigavel = amigavel;
  e.detalhe = detalhe;
  return e;
}

function mensagemErroCamera(e) {
  if (e && e.amigavel) return e.amigavel;
  if (e && e.name === "NotAllowedError") {
    return "Permita o acesso à câmera nas configurações do navegador e tente de novo.";
  }
  if (e && e.name === "NotFoundError") return "Nenhuma câmera foi encontrada neste aparelho.";
  return "Não foi possível continuar: " + (e && e.message ? e.message : "erro desconhecido");
}

el.btnIniciar.addEventListener("click", async () => {
  el.btnIniciar.disabled = true;
  ui.passo("virar", null);
  ui.passo("frente", null);
  ui.debug("");
  try {
    // A localização vem primeiro: o pedido de permissão precisa partir do toque do cliente
    // e ela é obrigatória (o banco também recusa o envio sem coordenadas válidas).
    ui.instrucao("Permita o acesso à localização quando o navegador pedir.");
    try {
      local = await SelfieCore.obterLocalizacao();
    } catch (e) {
      local = null;
      ui.instrucao((e && e.mensagem) || "Não foi possível obter a sua localização.");
      el.btnIniciar.textContent = "Tentar novamente";
      el.btnIniciar.disabled = false;
      return;
    }

    ui.instrucao("Carregando... (pode levar alguns segundos)");
    await SelfieCore.carregarModelos(); // só detector + landmarks: leve para o celular
    await SelfieCore.iniciarCamera(el.video, el.overlay);
    const r = await SelfieCore.executarDesafio(ui, { descritores: false });
    SelfieCore.pararCamera();

    if (!r.ok) {
      ui.instrucao(
        r.liveness
          ? "Não conseguimos capturar seu rosto de frente. Procure mais luz e tente de novo."
          : "Não deu certo desta vez. Vamos tentar de novo."
      );
      el.btnIniciar.textContent = "Tentar novamente";
      el.btnIniciar.disabled = false;
      return;
    }
    await enviar(r);
  } catch (e) {
    console.error(e);
    SelfieCore.pararCamera();
    ui.instrucao(mensagemErroCamera(e));
    if (e && e.detalhe) ui.debug("Detalhe técnico: " + e.detalhe); // ajuda a achar a causa quando algo falha
    el.btnIniciar.textContent = "Tentar novamente";
    el.btnIniciar.disabled = false;
  }
});

async function enviar(r) {
  ui.instrucao("Enviando sua selfie...");
  const caminho = `${token}/${Date.now()}.jpg`;

  const up = await client.storage
    .from("selfies")
    .upload(caminho, r.selfieBlob, { contentType: "image/jpeg", upsert: false });
  if (up.error) {
    const msg = String(up.error.message || "");
    const status = up.error.statusCode || up.error.status || "";
    const bloqueado = /row-level security|unauthorized|forbidden/i.test(msg) || String(status) === "403";
    throw erroEnvio(
      bloqueado
        ? "Não foi possível concluir. O link pode ter expirado ou já ter sido usado."
        : "Não foi possível enviar a selfie. Confira a internet e tente de novo.",
      `envio da imagem: ${status} ${msg}`.trim()
    );
  }

  if (!local) {
    throw erroEnvio("Não conseguimos a sua localização. Toque em tentar novamente.", "localização ausente");
  }
  const { data, error: err } = await client.rpc("finalizar_selfie", {
    p_token: token,
    p_selfie_path: caminho,
    p_liveness: r.liveness,
    p_latitude: local.latitude,
    p_longitude: local.longitude,
    p_precisao: local.precisao,
  });
  if (err) {
    // PGRST202 = o banco não tem a função com estes parâmetros (aplicativo e banco em versões diferentes)
    const naoExiste = err.code === "PGRST202" || /could not find the function/i.test(err.message || "");
    throw erroEnvio(
      naoExiste
        ? "O sistema está sendo atualizado e não conseguiu gravar a sua selfie. Avise quem enviou este link."
        : "Não foi possível gravar a selfie agora. Tente de novo em instantes.",
      `${err.code || "erro"}: ${err.message || ""}`
    );
  }
  if (data !== true) {
    throw erroEnvio(
      "Não foi possível concluir. O link pode ter expirado ou já ter sido usado.",
      `o servidor recusou o envio (resposta: ${JSON.stringify(data)})`
    );
  }
  mostrar("finalizado");
}

init().catch((e) => {
  console.error(e);
  erro("Ocorreu um erro inesperado. Tente novamente.");
});
