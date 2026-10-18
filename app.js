/* Teste local de verificação de selfie
 * A selfie fica no topo; o documento vem depois. O resultado aparece quando os dois existem.
 * Tudo roda no navegador. Nada é enviado para servidores.
 */

const LIMIAR_DISTANCIA = 0.5; // menor = mais parecido (0.6 é o padrão da lib; 0.5 é mais rígido)

const $ = (id) => document.getElementById(id);
const el = {
  etapaSelfie: $("etapaSelfie"), video: $("video"), overlay: $("overlay"),
  instrucao: $("instrucao"), debug: $("debug"), btnIniciar: $("btnIniciar"),
  passoVirar: $("passoVirar"), passoFrente: $("passoFrente"),
  docInput: $("docInput"), docPreview: $("docPreview"), docStatus: $("docStatus"),
  resultado: $("resultado"), resTexto: $("resTexto"), resDetalhe: $("resDetalhe"),
  resSelfie: $("resSelfie"), resDoc: $("resDoc"), btnRefazer: $("btnRefazer"),
};

let descritorDoc = null; // embedding do rosto do documento
let docUrl = null;       // URL local da imagem do documento
let selfie = null;       // resultado do desafio: { ok, liveness, frontal, descritores, selfieBlob, url }

function marcar(item, estado) {
  item.classList.remove("ok", "atual");
  if (estado) item.classList.add(estado);
}

const ui = {
  instrucao: (t) => { el.instrucao.textContent = t; },
  debug: (t) => { el.debug.textContent = t; },
  passo: (nome, estado) => marcar(nome === "virar" ? el.passoVirar : el.passoFrente, estado),
};

/* ---------- selfie ---------- */
el.btnIniciar.addEventListener("click", async () => {
  el.btnIniciar.disabled = true;
  el.resultado.hidden = true;
  selfie = null;
  ui.passo("virar", null);
  ui.passo("frente", null);
  ui.debug("");
  try {
    ui.instrucao("Carregando modelos (pode levar alguns segundos)...");
    await SelfieCore.carregarModelos({ reconhecimento: true });
    await SelfieCore.iniciarCamera(el.video, el.overlay);
    const r = await SelfieCore.executarDesafio(ui, { descritores: true });
    SelfieCore.pararCamera();
    selfie = { ...r, url: r.selfieBlob ? URL.createObjectURL(r.selfieBlob) : null };
    tentarFinalizar();
  } catch (e) {
    console.error(e);
    SelfieCore.pararCamera();
    ui.instrucao("Não foi possível acessar a câmera: " + e.message);
  } finally {
    el.btnIniciar.disabled = false;
    el.btnIniciar.textContent = "Refazer selfie";
  }
});

/* ---------- documento ---------- */
el.docInput.addEventListener("change", async () => {
  const file = el.docInput.files[0];
  if (!file) return;
  el.docStatus.textContent = "Carregando modelos e analisando o documento...";
  descritorDoc = null;

  try {
    await SelfieCore.carregarModelos({ reconhecimento: true });
    docUrl = URL.createObjectURL(file);
    el.docPreview.src = docUrl;
    el.docPreview.hidden = false;
    const img = await faceapi.fetchImage(docUrl);

    // SSD Mobilenet é mais robusto para fotos de documento
    const resultados = await faceapi
      .detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (resultados.length === 0) {
      el.docStatus.textContent = "Nenhum rosto encontrado. Tente uma foto mais nítida e bem iluminada.";
      return;
    }
    // Documentos costumam ter mais de um rosto (foto principal + marca d'água): usa o maior
    resultados.sort((a, b) => b.detection.box.area - a.detection.box.area);
    descritorDoc = resultados[0].descriptor;
    el.docStatus.textContent = "Rosto do documento detectado.";
    tentarFinalizar();
  } catch (e) {
    console.error(e);
    el.docStatus.textContent = "Erro ao analisar o documento: " + e.message;
  }
});

/* ---------- resultado (quando selfie e documento existem) ---------- */
function tentarFinalizar() {
  if (!selfie) return;

  if (!selfie.ok) {
    const motivo = selfie.liveness
      ? "Não foi possível capturar seu rosto de frente. Procure mais luz e tente de novo."
      : "Prova de vida: falhou ou expirou.";
    mostrarResultado({ aprovado: false, distancia: null, detalhe: motivo });
    return;
  }
  if (!descritorDoc) {
    ui.instrucao("Selfie capturada! Agora envie a foto do documento logo abaixo.");
    return;
  }
  // Mediana das distâncias entre cada amostra da selfie e o documento (mais estável que a média)
  const dists = selfie.descritores
    .map((d) => faceapi.euclideanDistance(descritorDoc, d))
    .sort((a, b) => a - b);
  const mediana = dists[Math.floor(dists.length / 2)];
  mostrarResultado({
    aprovado: mediana < LIMIAR_DISTANCIA,
    distancia: mediana,
    detalhe: `Distância facial: ${mediana.toFixed(3)} (limite ${LIMIAR_DISTANCIA})`,
  });
}

function mostrarResultado({ aprovado, distancia, detalhe }) {
  el.resultado.hidden = false;
  el.resTexto.className = "resultado " + (aprovado ? "ok" : "falha");
  el.resTexto.textContent = aprovado ? "Verificação aprovada" : "Verificação reprovada";
  el.resDetalhe.textContent = detalhe;
  el.resSelfie.hidden = !selfie || !selfie.url;
  if (selfie && selfie.url) el.resSelfie.src = selfie.url;
  el.resDoc.hidden = !docUrl || distancia === null;
  if (docUrl) el.resDoc.src = docUrl;
  el.resultado.scrollIntoView({ behavior: "smooth" });
}

el.btnRefazer.addEventListener("click", () => {
  el.resultado.hidden = true;
  selfie = null;
  ui.instrucao("");
  ui.debug("");
  ui.passo("virar", null);
  ui.passo("frente", null);
  el.etapaSelfie.scrollIntoView({ behavior: "smooth" });
});
