/* Núcleo compartilhado: modelos, câmera e desafio de prova de vida.
 * Usado por teste.html (teste local) e selfie.html (link para o cliente).
 *
 * Desafio: virar a cabeça para um lado sorteado e voltar a olhar para a frente.
 * Durante o "olhar para a frente" o rosto é amostrado e o melhor quadro vira a selfie.
 */
const SelfieCore = (() => {
  const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/";
  const VIRADA_MIN = 0.22;        // assimetria nariz/rosto para considerar a cabeça virada
  const FRENTE_MAX = 0.12;        // assimetria máxima para considerar o rosto "de frente"
  const AMOSTRAS_FRENTE = 5;      // quantos quadros de frente capturar
  const MIN_AMOSTRAS = 3;         // mínimo aceitável de quadros de frente
  const TEMPO_MAX_PASSO_MS = 12000;

  const carregados = new Set();
  let stream = null;
  let video = null;
  let overlay = null;

  const noop = () => {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 224 é mais rápido (importante no celular) e suficiente para uma selfie
  const optsDetector = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });

  /* ---------- modelos ---------- */
  // Sem "reconhecimento": só detector + landmarks (leve, ideal para a página do cliente).
  // Com "reconhecimento": também embeddings e o detector SSD (usado para comparar rostos).
  async function carregarModelos({ reconhecimento = false } = {}) {
    const nets = {
      tinyFaceDetector: faceapi.nets.tinyFaceDetector,
      faceLandmark68Net: faceapi.nets.faceLandmark68Net,
    };
    if (reconhecimento) {
      nets.faceRecognitionNet = faceapi.nets.faceRecognitionNet;
      nets.ssdMobilenetv1 = faceapi.nets.ssdMobilenetv1;
    }
    await Promise.all(
      Object.entries(nets)
        .filter(([nome]) => !carregados.has(nome))
        .map(async ([nome, net]) => {
          await net.loadFromUri(MODEL_URL);
          carregados.add(nome);
        })
    );
  }

  /* ---------- localização ----------
   * Pede a posição ao navegador (o usuário precisa permitir). Resolve com
   * { latitude, longitude, precisao } (precisao em metros) ou rejeita com
   * { codigo, mensagem }, uma frase pronta para mostrar ao cliente.
   * Tenta primeiro com GPS (alta precisão) e, se não vier a tempo, com a posição
   * aproximada (Wi-Fi/rede), que costuma funcionar em ambientes fechados.
   */
  function posicaoUmaVez(opcoes) {
    return new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, opcoes)
    );
  }

  async function obterLocalizacao() {
    if (!("geolocation" in navigator)) {
      throw { codigo: "indisponivel", mensagem: "Este navegador não consegue informar a localização. Abra o link no Chrome ou no Safari." };
    }
    let pos;
    try {
      pos = await posicaoUmaVez({ enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    } catch (e1) {
      if (e1.code === 1) throw erroLocalizacao(e1);
      try {
        pos = await posicaoUmaVez({ enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 });
      } catch (e2) {
        throw erroLocalizacao(e2);
      }
    }
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      precisao: pos.coords.accuracy,
    };
  }

  function erroLocalizacao(e) {
    if (e && e.code === 1) {
      return {
        codigo: "negada",
        mensagem:
          "A localização é necessária para esta verificação, mas o acesso foi negado. " +
          "Permita a localização para este site nas configurações do navegador (toque no cadeado ao lado do endereço) " +
          "e tente de novo. No iPhone, confira também Ajustes > Privacidade > Serviço de Localização.",
      };
    }
    if (e && e.code === 3) {
      return { codigo: "tempo", mensagem: "Não conseguimos obter a sua localização a tempo. Vá para um lugar aberto ou ligue o GPS e tente de novo." };
    }
    return { codigo: "indisponivel", mensagem: "Não foi possível obter a sua localização. Ligue o GPS e a internet do aparelho e tente de novo." };
  }

  /* ---------- câmera ---------- */
  async function iniciarCamera(videoEl, overlayEl) {
    video = videoEl;
    overlay = overlayEl;
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  }

  function pararCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (overlay) overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height);
  }

  function desenharCaixa(det) {
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!det) return;
    const { x, y, width, height } = det.detection.box;
    ctx.strokeStyle = "#2ecc71";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, width, height);
  }

  // Quadro atual do vídeo, sem espelhar (o espelho é só visual, via CSS)
  function snapshot() {
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    return c;
  }
  const canvasParaBlob = (c, qualidade = 0.92) =>
    new Promise((resolve) => c.toBlob(resolve, "image/jpeg", qualidade));

  /* ---------- geometria do rosto ---------- */
  function direcaoCabeca(landmarks) {
    // Compara a distância do nariz às bordas do rosto (contorno: pontos 0 e 16)
    const pts = landmarks.positions;
    const nariz = pts[30];
    const dEsq = Math.abs(nariz.x - pts[0].x);
    const dDir = Math.abs(pts[16].x - nariz.x);
    return (dEsq - dDir) / (dEsq + dDir); // ~0 = de frente; positivo/negativo = virado
  }

  async function esperarPasso(ui, testeFn) {
    const inicio = performance.now();
    while (performance.now() - inicio < TEMPO_MAX_PASSO_MS) {
      const det = await faceapi.detectSingleFace(video, optsDetector()).withFaceLandmarks();
      desenharCaixa(det);
      if (det) {
        if (testeFn(det)) return true;
      } else {
        ui.debug("Rosto não detectado: centralize o rosto e melhore a luz");
      }
      // sem sleep: a inferência já é lenta, e queremos o máximo de quadros possível
    }
    return false;
  }

  /* ---------- desafio ----------
   * ui = { instrucao(texto), debug(texto), passo(nome, estado) } (todos opcionais)
   *   nome: "virar" | "frente"; estado: "atual" | "ok" | null
   * Retorna { ok, liveness, frontal, descritores[], selfieBlob }
   *   liveness: virou a cabeça para o lado pedido
   *   frontal:  conseguiu amostras suficientes de frente
   *   ok:       liveness && frontal
   */
  async function executarDesafio(ui = {}, { descritores = false } = {}) {
    ui = { instrucao: noop, debug: noop, passo: noop, ...ui };
    const resultado = { ok: false, liveness: false, frontal: false, descritores: [], selfieBlob: null };

    // Passo 1: virar a cabeça (lado sorteado a cada tentativa)
    const lado = Math.random() < 0.5 ? "esquerda" : "direita";
    ui.instrucao(`Vire a cabeça para a sua ${lado}`);
    ui.passo("virar", "atual");
    // Sentido: os landmarks vêm da imagem crua da câmera (sem espelho). Quando a pessoa vira para a
    // SUA esquerda, o nariz anda para a direita da imagem crua e direcaoCabeca() fica positivo.
    // (A tela só exibe o vídeo espelhado; isso não muda o sinal da medida.)
    // "rumo" > 0 significa que a cabeça virou para o lado pedido.
    resultado.liveness = await esperarPasso(ui, (det) => {
      const d = direcaoCabeca(det.landmarks);
      const rumo = lado === "esquerda" ? d : -d;
      if (rumo < -0.1) ui.debug(`Esse é o lado contrário: vire para a sua ${lado}`);
      else ui.debug(`Giro ${Math.max(0, rumo).toFixed(2)} de ${VIRADA_MIN} necessário`);
      return rumo > VIRADA_MIN;
    });
    ui.passo("virar", resultado.liveness ? "ok" : null);
    if (!resultado.liveness) return resultado;

    // Passo 2: voltar a olhar para a frente; amostra o rosto e guarda o melhor quadro
    ui.instrucao("Agora volte a olhar para a frente");
    ui.passo("frente", "atual");
    let frontais = 0;
    let melhor = { q: -Infinity, canvas: null };
    const inicio = performance.now();
    while (frontais < AMOSTRAS_FRENTE && performance.now() - inicio < TEMPO_MAX_PASSO_MS) {
      let det = faceapi.detectSingleFace(video, optsDetector()).withFaceLandmarks();
      det = await (descritores ? det.withFaceDescriptor() : det);
      desenharCaixa(det);
      if (det) {
        const giro = direcaoCabeca(det.landmarks);
        if (Math.abs(giro) < FRENTE_MAX) {
          frontais++;
          if (descritores) resultado.descritores.push(det.descriptor);
          const qualidade = det.detection.score - Math.abs(giro);
          if (qualidade > melhor.q) melhor = { q: qualidade, canvas: snapshot() };
          ui.debug(`Capturando ${frontais}/${AMOSTRAS_FRENTE}`);
        } else {
          ui.debug(`Olhe direto para a câmera (giro ${giro.toFixed(2)}, precisa ficar abaixo de ${FRENTE_MAX})`);
        }
      } else {
        ui.debug("Rosto não detectado: centralize o rosto e melhore a luz");
      }
      await sleep(150);
    }

    if (frontais >= MIN_AMOSTRAS && melhor.canvas !== null) {
      resultado.selfieBlob = await canvasParaBlob(melhor.canvas); // pode vir null em caso de falha
    }
    resultado.frontal = resultado.selfieBlob !== null;
    resultado.ok = resultado.liveness && resultado.frontal;
    ui.passo("frente", resultado.ok ? "ok" : null);
    return resultado;
  }

  // Mude este valor (e o ?v= dos scripts nos .html) a cada publicação: o navegador do cliente
  // guarda JavaScript em cache e pode misturar arquivo novo com antigo.
  const VERSAO = "2026.10.17-c";

  return { VERSAO, carregarModelos, obterLocalizacao, iniciarCamera, pararCamera, executarDesafio, direcaoCabeca };
})();
