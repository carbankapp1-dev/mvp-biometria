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
function mensagemErroCamera(e) {
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
  if (up.error) throw new Error("Falha ao enviar a selfie: " + up.error.message);

  const { data, error: err } = await client.rpc("finalizar_selfie", {
    p_token: token,
    p_selfie_path: caminho,
    p_liveness: r.liveness,
  });
  if (err || data !== true) {
    throw new Error("Não foi possível concluir. O link pode ter expirado ou já ter sido usado.");
  }
  mostrar("finalizado");
}

init().catch((e) => {
  console.error(e);
  erro("Ocorreu um erro inesperado. Tente novamente.");
});
