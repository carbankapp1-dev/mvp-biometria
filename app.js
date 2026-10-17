/* Protótipo de verificação de selfie
 * - Face match: embeddings do face-api (distância euclidiana)
 * - Liveness ativo: virar a cabeça para um lado sorteado e voltar a olhar para a frente
 * Tudo roda no navegador. Só o resultado (sem imagens) vai ao Supabase.
 */

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
const LIMIAR_DISTANCIA = 0.5;   // menor = mais parecido (0.6 é o padrão da lib; 0.5 é mais rígido)
const FRENTE_MAX = 0.12;        // assimetria máxima para considerar o rosto "de frente"
const VIRADA_MIN = 0.22;        // assimetria nariz/rosto para considerar a cabeça virada
const TEMPO_MAX_PASSO_MS = 12000;

const $ = (id) => document.getElementById(id);
const el = {
  docInput: $("docInput"), docPreview: $("docPreview"), docStatus: $("docStatus"),
  etapa2: $("etapa2"), video: $("video"), overlay: $("overlay"),
  instrucao: $("instrucao"), btnIniciar: $("btnIniciar"),
  passoVirar: $("passoVirar"), passoFace: $("passoFace"),
  resultado: $("resultado"), resTexto: $("resTexto"), resDetalhe: $("resDetalhe"),
  btnRefazer: $("btnRefazer"),
};

let modelosCarregados = false;
let descritorDoc = null;
let stream = null;

/* ---------- utilidades ---------- */
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Linha de depuração sob a instrução: mostra o que o app está medindo
const debugEl = document.createElement("p");
debugEl.id = "debug";
debugEl.className = "status";
debugEl.style.textAlign = "center";
el.instrucao.after(debugEl);
const mostrarDebug = (t) => { debugEl.textContent = t; };

function direcaoCabeca(landmarks) {
  // Compara a distância do nariz às bordas do rosto (contorno: pontos 0 e 16)
  const pts = landmarks.positions;
  const nariz = pts[30];
  const esq = pts[0];
  const dir = pts[16];
  const dEsq = Math.abs(nariz.x - esq.x);
  const dDir = Math.abs(dir.x - nariz.x);
  return (dEsq - dDir) / (dEsq + dDir); // ~0 = de frente; positivo/negativo = virado
}

function marcar(item, estado) {
  item.classList.remove("ok", "atual");
  if (estado) item.classList.add(estado);
}

async function carregarModelos() {
  if (modelosCarregados) return;
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
  ]);
  modelosCarregados = true;
}

/* ---------- etapa 1: documento ---------- */
el.docInput.addEventListener("change", async () => {
  const file = el.docInput.files[0];
  if (!file) return;
  el.docStatus.textContent = "Carregando modelos e analisando o documento...";
  el.etapa2.hidden = true;
  descritorDoc = null;

  try {
    await carregarModelos();
    const url = URL.createObjectURL(file);
    el.docPreview.src = url;
    el.docPreview.hidden = false;
    const img = await faceapi.fetchImage(url);

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
    el.docStatus.textContent = "Rosto do documento detectado. Siga para a selfie.";
    el.etapa2.hidden = false;
    el.etapa2.scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    console.error(e);
    el.docStatus.textContent = "Erro ao analisar o documento: " + e.message;
  }
});

/* ---------- etapa 2: selfie ao vivo ---------- */
el.btnIniciar.addEventListener("click", async () => {
  el.btnIniciar.disabled = true;
  try {
    await carregarModelos();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    el.video.srcObject = stream;
    await el.video.play();
    el.overlay.width = el.video.videoWidth;
    el.overlay.height = el.video.videoHeight;
    await executarVerificacao();
  } catch (e) {
    console.error(e);
    el.instrucao.textContent = "Não foi possível acessar a câmera: " + e.message;
    el.btnIniciar.disabled = false;
  }
});

// 224 é mais rápido (importante no celular) e suficiente para uma selfie, em que o rosto ocupa boa parte do quadro
const optsDetector = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });

async function detectarFrame() {
  return faceapi.detectSingleFace(el.video, optsDetector()).withFaceLandmarks();
}

function desenharCaixa(det) {
  const ctx = el.overlay.getContext("2d");
  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  if (!det) return;
  const { x, y, width, height } = det.detection.box;
  ctx.strokeStyle = "#2ecc71";
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, width, height);
}

async function esperarPasso(nome, testeFn) {
  const inicio = performance.now();
  while (performance.now() - inicio < TEMPO_MAX_PASSO_MS) {
    const det = await detectarFrame();
    desenharCaixa(det);
    if (det && (await testeFn(det))) return true;
    if (!det) mostrarDebug("Rosto não detectado: centralize o rosto e melhore a luz");
    // sem sleep: a inferência já é lenta, e queremos o máximo de quadros possível
  }
  return false;
}

async function passoVirar() {
  const lado = Math.random() < 0.5 ? "esquerda" : "direita";
  el.instrucao.textContent = `Vire a cabeça para a ${lado}`;
  marcar(el.passoVirar, "atual");
  // O vídeo está espelhado na tela, então o sinal é invertido para o usuário
  const ok = await esperarPasso("virar", (det) => {
    const d = direcaoCabeca(det.landmarks);
    mostrarDebug(`Giro ${d.toFixed(2)} (precisa passar de ${VIRADA_MIN} para o lado pedido)`);
    return lado === "esquerda" ? d < -VIRADA_MIN : d > VIRADA_MIN;
  });
  marcar(el.passoVirar, ok ? "ok" : null);
  return ok;
}

async function passoFace() {
  el.instrucao.textContent = "Agora volte a olhar para a frente";
  marcar(el.passoFace, "atual");
  // Espera o rosto voltar ao centro (provando o movimento) e captura algumas amostras
  const distancias = [];
  const inicio = performance.now();
  while (distancias.length < 5 && performance.now() - inicio < TEMPO_MAX_PASSO_MS) {
    const det = await faceapi
      .detectSingleFace(el.video, optsDetector())
      .withFaceLandmarks()
      .withFaceDescriptor();
    desenharCaixa(det);
    if (det) {
      const giro = direcaoCabeca(det.landmarks);
      if (Math.abs(giro) < FRENTE_MAX) {
        const dd = faceapi.euclideanDistance(descritorDoc, det.descriptor);
        distancias.push(dd);
        mostrarDebug(`Amostra ${distancias.length}/5 • distância ${dd.toFixed(3)} (limite ${LIMIAR_DISTANCIA})`);
      } else {
        mostrarDebug(`Olhe direto para a câmera (giro ${giro.toFixed(2)}, precisa ficar abaixo de ${FRENTE_MAX})`);
      }
    }
    await sleep(150);
  }
  if (distancias.length < 3) {
    marcar(el.passoFace, null);
    return { ok: false, distancia: null };
  }
  // Mediana é mais estável do que a média
  distancias.sort((a, b) => a - b);
  const mediana = distancias[Math.floor(distancias.length / 2)];
  const ok = mediana < LIMIAR_DISTANCIA;
  marcar(el.passoFace, ok ? "ok" : null);
  return { ok, distancia: mediana };
}

async function executarVerificacao() {
  [el.passoVirar, el.passoFace].forEach((p) => marcar(p, null));

  // O lado sorteado a cada tentativa dificulta ataques com vídeo gravado
  const liveness = await passoVirar();

  let face = { ok: false, distancia: null };
  if (liveness) face = await passoFace();

  pararCamera();
  mostrarResultado(liveness, face);
}

function pararCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  const ctx = el.overlay.getContext("2d");
  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
}

/* ---------- resultado ---------- */
async function mostrarResultado(liveness, face) {
  const aprovado = liveness && face.ok;
  el.resultado.hidden = false;
  el.resTexto.className = "resultado " + (aprovado ? "ok" : "falha");
  el.resTexto.textContent = aprovado ? "Verificação aprovada" : "Verificação reprovada";

  const partes = [];
  partes.push(liveness ? "Prova de vida: ok" : "Prova de vida: falhou ou expirou");
  if (face.distancia !== null) {
    partes.push(`Distância facial: ${face.distancia.toFixed(3)} (limite ${LIMIAR_DISTANCIA})`);
  }
  el.resDetalhe.textContent = partes.join(" • ");
  el.resultado.scrollIntoView({ behavior: "smooth" });

  await salvarResultado({ aprovado, liveness, distancia: face.distancia });
}

async function salvarResultado({ aprovado, liveness, distancia }) {
  const cfg = window.APP_CONFIG;
  if (!cfg || !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("SEU-PROJETO")) return; // Supabase opcional
  try {
    const client = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const { error } = await client.from("verificacoes").insert({
      aprovado,
      liveness,
      distancia,
      limiar: LIMIAR_DISTANCIA,
      user_agent: navigator.userAgent,
    });
    if (error) throw error;
  } catch (e) {
    console.warn("Não foi possível salvar no Supabase:", e.message);
  }
}

el.btnRefazer.addEventListener("click", () => {
  el.resultado.hidden = true;
  el.btnIniciar.disabled = false;
  el.instrucao.textContent = "Clique em iniciar e siga as instruções.";
  mostrarDebug("");
  [el.passoVirar, el.passoFace].forEach((p) => marcar(p, null));
  el.etapa2.scrollIntoView({ behavior: "smooth" });
});
