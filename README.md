# Verificação de identidade por selfie (protótipo)

Site estático (GitHub Pages) com Supabase. O operador sobe a foto de um documento, gera um link e envia ao cliente. O cliente abre o link, faz uma selfie ao vivo, e o operador compara selfie e documento lado a lado no painel.

## Páginas

| Arquivo | Para quem | O que faz |
|---|---|---|
| `index.html` | Operador (login) | Página inicial do site: sobe o documento, gera o link, compara documento x selfie, aprova/reprova, exclui. No topo, ícones para o teste local e para sair |
| `selfie.html?t=TOKEN` | Cliente (sem login) | Termo de consentimento, selfie com prova de vida, envio |
| `teste.html` | Qualquer um | Teste local, sem banco: selfie no topo, documento abaixo |

Arquivos de apoio: `admin.js` (lógica do painel), `app.js` (lógica do teste local), `core.js` (câmera, modelos e prova de vida), `selfie.js` (lógica da página do cliente), `style.css`, `config.js`, `supabase.sql`, e os arquivos do aplicativo instalável: `manifest.webmanifest`, `sw.js`, `pwa.js` e a pasta `icons/`.

## Como funciona

1. O operador envia a foto do documento. O painel confere se há um rosto nela, guarda a imagem num bucket **privado** e cria uma solicitação com um token aleatório de 64 caracteres.
2. O link `selfie.html?t=TOKEN` vai ao cliente (há botão de WhatsApp). Ele vale **uma vez** e expira em 24, 48 ou 72 horas.
3. O cliente aceita o termo, vira a cabeça para o lado sorteado e volta a olhar para a frente. O melhor quadro de frente vira a selfie e é enviada a um bucket privado.
4. No painel, o operador abre "Comparar": documento e selfie aparecem lado a lado, com a distância facial calculada **no navegador do operador**. A decisão (aprovar ou reprovar) é dele.

O cliente nunca informa nem calcula a distância. Ele só consegue consultar o status do próprio link e enviar uma selfie para a pasta do próprio token. Não consegue ler tabelas nem baixar imagens.

## Configuração

### 1. Supabase

1. Crie um projeto em supabase.com.
2. Em **SQL Editor**, cole e rode o conteúdo de `supabase.sql` (pode rodar mais de uma vez).
3. Em **Authentication > Users**, clique em *Add user* e crie o seu usuário de operador (e-mail e senha, com *Auto Confirm User* marcado).
4. **Importante:** em **Authentication > Sign In / Providers**, desligue *Allow new users to sign up*. Sem isso, qualquer pessoa com a chave pública consegue criar uma conta, gerar links e ocupar o seu armazenamento. (Ela não consegue ver os seus dados, mas pode abusar do serviço.)
5. Em **Project Settings > API**, copie a URL e a chave **anon** para o `config.js`. Nunca use a chave `service_role` no front-end.

`config.js` aceita ainda um campo opcional `EMPRESA_NOME`, que aparece no termo de consentimento do cliente:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://SEU-PROJETO.supabase.co",
  SUPABASE_ANON_KEY: "SUA-CHAVE-ANON",
  EMPRESA_NOME: "Nome da sua empresa",
};
```

### 2. GitHub Pages

1. Suba todos os arquivos para o repositório.
2. Em **Settings > Pages**, escolha a branch `main` e a pasta `/ (root)`.
3. Acesse `https://SEU-USUARIO.github.io/NOME-DO-REPO/`. O painel do operador abre direto.

A câmera exige HTTPS, que o GitHub Pages já oferece. Para testar localmente: `python3 -m http.server 8000` e abra `http://localhost:8000`.

## Instalar como aplicativo (PWA)

O painel pode ser instalado e abre em tela cheia, sem a barra do navegador, com o ícone "Biometria".

- **Android (Chrome):** abra o site, toque nos três pontos e escolha *Instalar app* (ou *Adicionar à tela inicial*).
- **iPhone (Safari):** toque em Compartilhar e depois em *Adicionar à Tela de Início*.
- **Computador (Chrome/Edge):** use o ícone de instalar na barra de endereço.

O que o PWA faz e não faz:

- Guarda as bibliotecas e os modelos de reconhecimento facial (cerca de 12 MB) depois do primeiro uso, então a análise carrega mais rápido nas vezes seguintes.
- **Não funciona offline de verdade:** login, upload e comparação dependem do Supabase.
- Os arquivos do site são buscados primeiro na rede, então uma atualização publicada no GitHub aparece logo. O cache só entra se a conexão falhar.
- A página do cliente (`selfie.html`) e as chamadas ao Supabase nunca passam pelo cache.
- Se trocar a versão de uma biblioteca do CDN, aumente `VERSAO` em `sw.js` para descartar o cache antigo.
- Para mudar nome, cor ou ícone do app, edite `manifest.webmanifest`. Depois de instalado, o Android pode levar um tempo para atualizar o ícone; se não mudar, desinstale e instale de novo.

## Limitações e cuidados

- **A prova de vida roda no navegador do cliente.** Quem sabe mexer em requisições consegue enviar qualquer JPEG com a chave pública e o token. O resultado "Rostos compatíveis" é um apoio à sua análise visual, não uma garantia. Para risco real de fraude (conta bancária, crédito), use verificação feita no servidor ou um serviço de liveness.
- **Deepfake, vídeo editado e câmera virtual** não são detectados.
- **LGPD:** selfie e documento são dados pessoais, e a selfie é dado biométrico sensível. Para uso real você precisa de base legal, texto de consentimento revisado por um advogado (o texto da página é genérico), política de retenção e controle de acesso. O botão *Excluir* do painel apaga o registro e as imagens.
- **Retenção:** links que o cliente nunca concluiu podem deixar arquivos no storage. O `supabase.sql` traz um exemplo (comentado) de limpeza com `pg_cron`; as imagens precisam ser removidas pelo painel ou por uma Edge Function agendada.
- **Navegadores dentro de apps** (alguns navegadores embutidos do WhatsApp/Instagram, sobretudo no iPhone) podem bloquear a câmera. Se acontecer, peça ao cliente para abrir o link no Chrome ou no Safari.
- **Modelos:** o reconhecimento usa o face-api (modelo de 2017-2018), com precisão inferior à dos modelos atuais. Ajuste `LIMIAR_DISTANCIA` (hoje 0,5) em `app.js` e `admin.js` conforme os seus testes.
- **Dependências de CDN:** as versões estão fixadas (`face-api 1.7.15`, `supabase-js 2.118.0`). Para proteção extra contra adulteração do CDN, adicione `integrity` e `crossorigin="anonymous"` nas tags `<script>`. Hashes calculados a partir dos pacotes do npm (não consegui conferi-los contra o que o CDN serve, então teste antes de publicar; se a página parar de carregar com erro de *integrity* no console, remova o atributo):
  - `face-api.js`: `sha384-M5nePoB6/w/a9JhtegEibSLGiJy/+QMZZMfvcxjWVCQW/HPwrQ7i21V/Px/8AyVA`
  - `supabase.js`: `sha384-TcHRA3zBbn+Lexh5n+Oil4guNPOS3rjNDpGRAN46u/s/mB2IZ50ceC6TYDU2yvgK`
