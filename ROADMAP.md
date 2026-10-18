# Roteiro — próximas etapas

## Etapa futura: verificação facial no servidor com AWS Rekognition

**Decisão (18/10/2026):** o dono do projeto gostou da opção AWS Rekognition e deixou para uma próxima etapa. Nada disso foi implementado.

### Situação atual (versão 2026.10.18-a)
- A comparação dos rostos roda no navegador do operador (face-api, limiar de distância 0,5).
- A prova de vida (virar a cabeça para um lado sorteado e depois olhar para a frente) roda no navegador do cliente.
- A localização (GPS, IP e endereço via OpenCage na Edge Function `geocode`) é enviada pelo cliente.
- Qualquer um desses resultados pode ser forjado por quem editar o JavaScript do cliente. Servem como evidência, não como prova.

### O que mudaria com o Rekognition
- Uma Edge Function do Supabase chamaria a AWS assim que a selfie chegasse. O resultado ficaria gravado no banco e o painel mostraria a nota pronta, sem baixar os modelos (cerca de 12 MB).
- Comparação: `CompareFaces` entre o documento e a selfie, com nota de similaridade.
- Prova de vida: Face Liveness da AWS, em que o servidor sorteia o desafio e confere a resposta. Isso fecha a maior brecha atual e substitui a prova de vida do navegador.
- Decisão automática: aprovar, reprovar ou enviar para revisão manual conforme a nota.

### Pontos a decidir ou verificar quando chegar a hora
- Custo por verificação e região da AWS (LGPD: dado biométrico enviado a um operador, ou seja, a AWS; ver contrato e base legal).
- As Edge Functions têm limite de 2 s de CPU e 256 MB. A chamada à AWS cabe, porque o processamento pesado fica do lado da AWS.
- O Face Liveness exige um SDK no front-end (AWS Amplify) e uma conta AWS com credenciais guardadas como secrets do Supabase, nunca no front-end.
- Rever a documentação atual da AWS antes de começar, porque preços e SDKs mudam.
- Manter o teste local (`teste.html`) como está, sem backend.

### Fora do alcance, mesmo com o Rekognition
- Deepfake e câmera virtual só são mitigados pelo Face Liveness, sem garantia total.
- A localização continua informada pelo cliente e portanto falsificável.

### Alternativa descartada por enquanto
- Servidor próprio em Python com InsightFace (Cloud Run ou Fly.io): mais controle, mas exige manter servidor, e a prova de vida seria a parte difícil de construir.
