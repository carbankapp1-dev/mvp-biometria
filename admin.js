/* Painel do operador
 *  - Login (Supabase Auth, e-mail e senha)
 *  - Sobe o documento (bucket privado) e gera o link para o cliente
 *  - Lista as solicitações; compara documento x selfie lado a lado, neste navegador
 *    (o cliente nunca calcula nem informa a distância: ela vem daqui)
 */

const $ = (id) => document.getElementById(id);
const cfg = window.APP_CONFIG || {};
const LIMIAR_DISTANCIA = 0.5; // menor = mais parecido

const ROTULO_STATUS = {
  pendente: "Aguardando selfie",
  selfie_enviada: "Selfie recebida",
  aprovado: "Aprovado",
  reprovado: "Reprovado",
};

let client = null;
let usuario = null;
let atual = null; // { sol, distancia } da comparação aberta
let urlsComparacao = [];

/* ---------- utilidades ---------- */
function h(tag, props = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const f of filhos) e.append(f);
  return e;
}

const fmtData = (iso) =>
  new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

function linkDaSolicitacao(token) {
  const u = new URL("selfie.html", location.href);
  u.search = "";
  u.hash = "";
  u.searchParams.set("t", token);
  return u.toString();
}

async function copiar(texto, botao) {
  try {
    await navigator.clipboard.writeText(texto);
    const original = botao.textContent;
    botao.textContent = "Copiado!";
    setTimeout(() => { botao.textContent = original; }, 1500);
  } catch {
    window.prompt("Copie o link:", texto);
  }
}

// Reduz a imagem (lado maior 1600px) e normaliza a orientação do EXIF, gerando um JPEG.
async function reduzirImagem(file, maxLado = 1600, qualidade = 0.9) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Não foi possível abrir a imagem. Use JPG ou PNG."));
      i.src = url;
    });
    const escala = Math.min(1, maxLado / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * escala);
    c.height = Math.round(img.naturalHeight * escala);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", qualidade));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Embedding do maior rosto da imagem (documentos podem ter mais de um rosto)
async function descritorDoRosto(img) {
  const rs = await faceapi
    .detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptors();
  if (!rs.length) return null;
  rs.sort((a, b) => b.detection.box.area - a.detection.box.area);
  return rs[0].descriptor;
}

async function baixar(bucket, caminho) {
  const { data, error } = await client.storage.from(bucket).download(caminho);
  if (error) throw new Error(`Não foi possível baixar a imagem (${bucket}): ${error.message}`);
  return data; // Blob
}

/* ---------- sessão ---------- */
function aplicarSessao() {
  $("login").hidden = !!usuario;
  $("painel").hidden = !usuario;
  $("acoes").hidden = !usuario;
  $("versao").textContent = "v" + (SelfieCore.VERSAO || "antiga");
  if (usuario) {
    // O e-mail da conta aparece só como dica do botão Sair (sem ocupar espaço na tela)
    const rotuloSair = usuario.email ? `Sair (${usuario.email})` : "Sair";
    $("btnSair").title = rotuloSair;
    $("btnSair").setAttribute("aria-label", rotuloSair);
    setTimeout(listar, 0); // não chamar o supabase direto dentro do callback de auth
  } else {
    fecharComparacao();
    $("lista").replaceChildren();
  }
}

function iniciar() {
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes("SEU-PROJETO")) {
    $("configErro").hidden = false;
    return;
  }
  client = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  client.auth.onAuthStateChange((evento, session) => {
    const novo = session ? session.user : null;
    const mudou = (novo ? novo.id : null) !== (usuario ? usuario.id : null);
    usuario = novo;
    if (mudou || evento === "INITIAL_SESSION") aplicarSessao();
  });
}

$("formLogin").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginErro").textContent = "";
  const { error } = await client.auth.signInWithPassword({
    email: $("loginEmail").value.trim(),
    password: $("loginSenha").value,
  });
  if (error) $("loginErro").textContent = "Não foi possível entrar: " + error.message;
  else $("loginSenha").value = "";
});

$("btnSair").addEventListener("click", () => client.auth.signOut());

/* ---------- nova verificação ---------- */
$("formNova").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("docArquivo").files[0];
  if (!file) return;

  const btn = $("btnGerar");
  const status = $("statusNova");
  btn.disabled = true;
  $("resultadoLink").hidden = true;
  let caminho = null;

  try {
    status.textContent = "Preparando a imagem...";
    const blob = await reduzirImagem(file);

    // Confirma que há um rosto no documento antes de gerar o link
    status.textContent = "Carregando modelos e conferindo o rosto no documento...";
    await SelfieCore.carregarModelos({ reconhecimento: true });
    const img = await faceapi.bufferToImage(blob);
    const descritor = await descritorDoRosto(img);
    if (!descritor) {
      status.textContent = "Nenhum rosto encontrado no documento. Envie uma foto mais nítida e bem iluminada.";
      return;
    }

    status.textContent = "Salvando o documento...";
    caminho = `${usuario.id}/${crypto.randomUUID()}.jpg`;
    const up = await client.storage
      .from("documentos")
      .upload(caminho, blob, { contentType: "image/jpeg", upsert: false });
    if (up.error) throw new Error("Falha ao salvar o documento: " + up.error.message);

    const horas = Number($("validade").value) || 48;
    const nome = $("nomeCliente").value.trim();
    const { data, error } = await client
      .from("solicitacoes")
      .insert({
        nome_cliente: nome || null,
        documento_path: caminho,
        expira_em: new Date(Date.now() + horas * 3600 * 1000).toISOString(),
      })
      .select("token")
      .single();
    if (error) {
      await client.storage.from("documentos").remove([caminho]);
      throw new Error("Falha ao criar a solicitação: " + error.message);
    }

    const link = linkDaSolicitacao(data.token);
    $("linkInput").value = link;
    $("linkWhats").href =
      "https://wa.me/?text=" +
      encodeURIComponent(
        `Olá${nome ? " " + nome : ""}! Para concluir sua verificação de identidade, tire uma selfie neste link: ${link}`
      );
    $("resultadoLink").hidden = false;
    status.textContent = "Link gerado. Ele funciona uma única vez e expira no prazo escolhido.";
    $("formNova").reset();
    listar();
  } catch (err) {
    console.error(err);
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("btnCopiar").addEventListener("click", (e) => copiar($("linkInput").value, e.currentTarget));

/* ---------- lista ---------- */
async function listar() {
  const statusLista = $("statusLista");
  statusLista.textContent = "Carregando...";
  const { data, error } = await client
    .from("solicitacoes")
    .select("id, token, criado_em, expira_em, nome_cliente, documento_path, selfie_path, status, liveness_cliente, distancia, latitude, longitude, precisao_m, ip_cliente, endereco")
    .order("criado_em", { ascending: false })
    .limit(50);
  if (error) {
    statusLista.textContent = "Erro ao carregar: " + error.message;
    return;
  }
  statusLista.textContent = data.length ? "" : "Nenhuma solicitação ainda.";
  $("lista").replaceChildren(...data.map(itemDaLista));
}

function itemDaLista(sol) {
  const expirou = sol.status === "pendente" && new Date(sol.expira_em) < new Date();
  const rotulo = expirou ? "Expirado" : ROTULO_STATUS[sol.status] || sol.status;
  const classe = expirou ? "" : sol.status;

  const acoes = h("div", { class: "linha", style: "margin-top:8px" });
  if (sol.status === "pendente" && !expirou) {
    const b = h("button", { class: "btn-sm btn-sec" }, "Copiar link");
    b.addEventListener("click", () => copiar(linkDaSolicitacao(sol.token), b));
    acoes.append(b);
  }
  if (sol.selfie_path) {
    acoes.append(h("button", { class: "btn-sm", onclick: () => comparar(sol) }, "Comparar"));
  }
  acoes.append(h("button", { class: "btn-sm btn-perigo", onclick: () => excluir(sol) }, "Excluir"));

  const info = [`Criada em ${fmtData(sol.criado_em)}`, `expira em ${fmtData(sol.expira_em)}`];
  if (sol.distancia !== null && sol.distancia !== undefined) {
    info.push(`distância ${Number(sol.distancia).toFixed(3)}`);
  }

  return h(
    "div",
    { class: "item" },
    h("h3", {}, sol.nome_cliente || "Sem nome", h("span", { class: "badge " + classe }, rotulo)),
    h("div", { class: "status" }, info.join(" • ")),
    acoes
  );
}

$("btnAtualizar").addEventListener("click", listar);

/* ---------- comparação ---------- */
function limparUrlsComparacao() {
  urlsComparacao.forEach((u) => URL.revokeObjectURL(u));
  urlsComparacao = [];
}

function fecharComparacao() {
  cmpSeq++; // respostas que ainda estão a caminho não devem preencher a tela
  $("comparacao").hidden = true;
  $("cmpLocal").hidden = true;
  limparUrlsComparacao();
  atual = null;
}
$("btnFecharCmp").addEventListener("click", fecharComparacao);

/* ---------- localização da selfie ---------- */
let cmpSeq = 0; // identifica a comparação aberta

const fmtCoord = (n) => Number(n).toFixed(6);

async function mensagemDaFuncao(error) {
  try {
    const resp = error && error.context;
    if (resp && typeof resp.json === "function") {
      if (resp.status === 404) {
        return "A função de endereço ainda não foi publicada no Supabase (veja o passo a passo no README).";
      }
      const corpo = await resp.json();
      if (corpo && corpo.mensagem) return corpo.mensagem;
    }
  } catch {
    // corpo ilegível: cai na mensagem genérica
  }
  return "Não foi possível consultar o endereço agora. Tente de novo em instantes.";
}

async function buscarEndereco(sol) {
  const minha = cmpSeq;
  const campo = $("cmpEndereco");
  $("btnEndereco").hidden = true;
  if (sol.endereco) {
    campo.textContent = sol.endereco;
    return;
  }
  campo.textContent = "Buscando o endereço...";
  const { data, error } = await client.functions.invoke("geocode", { body: { id: sol.id } });
  if (minha !== cmpSeq) return;
  if (error) {
    const msg = await mensagemDaFuncao(error);
    if (minha !== cmpSeq) return;
    campo.textContent = msg;
    $("btnEndereco").hidden = false;
    return;
  }
  if (data && data.endereco) {
    sol.endereco = data.endereco; // evita nova consulta ao reabrir esta solicitação
    campo.textContent = data.endereco;
  } else {
    campo.textContent = (data && data.mensagem) || "Nenhum endereço encontrado para essas coordenadas.";
  }
}

function mostrarLocalizacao(sol) {
  $("cmpLocal").hidden = false;
  $("btnEndereco").hidden = true;

  const temLocal = typeof sol.latitude === "number" && typeof sol.longitude === "number";
  if (!temLocal) {
    $("cmpEndereco").textContent = "Esta solicitação não tem localização registrada.";
    $("cmpCoords").textContent = sol.ip_cliente ? `IP ${sol.ip_cliente}` : "";
    $("cmpMapa").hidden = true;
    return;
  }

  const partes = [`${fmtCoord(sol.latitude)}, ${fmtCoord(sol.longitude)}`];
  if (typeof sol.precisao_m === "number") {
    partes.push(`precisão de cerca de ${Math.round(sol.precisao_m)} m`);
    if (sol.precisao_m > 1000) partes.push("localização aproximada: pode estar a alguns quilômetros");
  }
  if (sol.ip_cliente) partes.push(`IP ${sol.ip_cliente}`);
  $("cmpCoords").textContent = partes.join(" • ");
  $("cmpMapa").href = `https://www.google.com/maps?q=${fmtCoord(sol.latitude)},${fmtCoord(sol.longitude)}`;
  $("cmpMapa").hidden = false;
  buscarEndereco(sol);
}

$("btnEndereco").addEventListener("click", () => {
  if (atual) buscarEndereco(atual.sol);
});

async function comparar(sol) {
  const minha = ++cmpSeq;
  limparUrlsComparacao();
  atual = null;
  $("cmpLocal").hidden = true;
  $("comparacao").hidden = false;
  $("cmpDoc").hidden = true;
  $("cmpSelfie").hidden = true;
  $("cmpVeredito").textContent = "";
  $("cmpVeredito").className = "resultado";
  $("cmpDetalhe").textContent = "";
  $("btnAprovar").disabled = true;
  $("btnReprovar").disabled = true;
  $("cmpStatus").textContent = "Baixando as imagens...";
  $("comparacao").scrollIntoView({ behavior: "smooth" });

  try {
    const [docBlob, selfieBlob] = await Promise.all([
      baixar("documentos", sol.documento_path),
      baixar("selfies", sol.selfie_path),
    ]);
    if (minha !== cmpSeq) return; // outra comparação foi aberta (ou esta foi fechada) enquanto baixava
    const urlDoc = URL.createObjectURL(docBlob);
    const urlSelfie = URL.createObjectURL(selfieBlob);
    urlsComparacao.push(urlDoc, urlSelfie);
    $("cmpDoc").src = urlDoc;
    $("cmpSelfie").src = urlSelfie;
    $("cmpDoc").hidden = false;
    $("cmpSelfie").hidden = false;

    // As imagens já aparecem; os botões de decisão valem mesmo se a análise automática falhar
    $("btnAprovar").disabled = false;
    $("btnReprovar").disabled = false;
    atual = { sol, distancia: null };

    // A localização não depende da análise facial: aparece e busca o endereço em paralelo
    mostrarLocalizacao(sol);

    $("cmpStatus").textContent = "Carregando modelos e calculando a distância...";
    await SelfieCore.carregarModelos({ reconhecimento: true });
    const dDoc = await descritorDoRosto(await faceapi.bufferToImage(docBlob));
    const dSelfie = await descritorDoRosto(await faceapi.bufferToImage(selfieBlob));
    if (!dDoc || !dSelfie) {
      $("cmpStatus").textContent = "";
      $("cmpDetalhe").textContent =
        `Não foi possível detectar o rosto ${!dDoc ? "no documento" : "na selfie"}. Decida pela comparação visual.`;
      return;
    }

    const distancia = faceapi.euclideanDistance(dDoc, dSelfie);
    atual.distancia = distancia;
    const compativel = distancia < LIMIAR_DISTANCIA;
    $("cmpStatus").textContent = "";
    $("cmpVeredito").className = "resultado " + (compativel ? "ok" : "falha");
    $("cmpVeredito").textContent = compativel ? "Rostos compatíveis" : "Rostos NÃO compatíveis";
    $("cmpDetalhe").textContent =
      `Distância ${distancia.toFixed(3)} (limite ${LIMIAR_DISTANCIA}). ` +
      `Prova de vida informada pelo navegador do cliente: ${sol.liveness_cliente ? "sim" : "não"} (não é garantia). ` +
      "A decisão final é sua: confira as imagens lado a lado.";
  } catch (err) {
    console.error(err);
    $("cmpStatus").textContent = err.message;
  }
}

async function decidir(status) {
  if (!atual) return;
  const campos = { status };
  if (atual.distancia !== null) campos.distancia = atual.distancia;
  const { error } = await client.from("solicitacoes").update(campos).eq("id", atual.sol.id);
  if (error) {
    $("cmpStatus").textContent = "Erro ao salvar a decisão: " + error.message;
    return;
  }
  fecharComparacao();
  listar();
}
$("btnAprovar").addEventListener("click", () => decidir("aprovado"));
$("btnReprovar").addEventListener("click", () => decidir("reprovado"));

/* ---------- exclusão (LGPD: apaga imagens e registro) ---------- */
async function excluir(sol) {
  if (!window.confirm("Excluir esta verificação e as imagens? Esta ação não pode ser desfeita.")) return;
  try {
    const rm1 = await client.storage.from("documentos").remove([sol.documento_path]);
    if (rm1.error) throw new Error(rm1.error.message);

    const { data: arquivos, error: errList } = await client.storage.from("selfies").list(sol.token);
    if (errList) throw new Error(errList.message);
    if (arquivos && arquivos.length) {
      const rm2 = await client.storage.from("selfies").remove(arquivos.map((f) => `${sol.token}/${f.name}`));
      if (rm2.error) throw new Error(rm2.error.message);
    }

    const { error } = await client.from("solicitacoes").delete().eq("id", sol.id);
    if (error) throw new Error(error.message);
    if (atual && atual.sol.id === sol.id) fecharComparacao();
    listar();
  } catch (err) {
    console.error(err);
    $("statusLista").textContent = "Erro ao excluir: " + err.message;
  }
}

iniciar();
