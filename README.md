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
3. O cliente aceita o termo (que cita selfie, localização e IP), permite o acesso à **localização**, vira a cabeça para o lado sorteado e volta a olhar para a frente. O melhor quadro de frente vira a selfie e é enviada a um bucket privado, junto com as coordenadas. Sem a permissão de localização a selfie não é enviada.
4. No painel, o operador abre "Comparar": documento e selfie aparecem lado a lado, com a distância facial calculada **no navegador do operador**. Logo abaixo, o bloco **"Onde a selfie foi feita"** mostra o endereço (buscado no OpenCage), as coordenadas, a precisão, o IP e um link para o mapa. A decisão (aprovar ou reprovar) é dele.

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

### 3. Localização e endereço (OpenCage)

O navegador do cliente informa as coordenadas. O **endereço** é buscado no OpenCage por uma Edge Function do Supabase (`supabase/functions/geocode/index.ts`), porque a chave do OpenCage não pode ficar no código do site: qualquer pessoa a copiaria e gastaria a sua cota.

1. **Banco:** rode o `supabase.sql` de novo no SQL Editor. Ele acrescenta as colunas de localização e troca a função `finalizar_selfie` pela versão que exige as coordenadas.
2. **Publicar a função** (pelo painel, sem instalar nada): em **Edge Functions**, clique em *Deploy a new function* > *Via Editor*, dê o nome exato `geocode`, apague o exemplo, cole o conteúdo de `supabase/functions/geocode/index.ts` e publique.
3. **Cadastrar a chave:** em **Edge Functions > Secrets** (`https://supabase.com/dashboard/project/_/functions/secrets`), crie o segredo `OPENCAGE_API_KEY` com a sua chave e salve. A função usa o novo valor sem precisar publicar de novo. Só donos e administradores do projeto criam segredos. **Não cole a chave no chat, no `config.js` nem no repositório.**
4. Suba para o GitHub os arquivos atualizados (`core.js`, `selfie.js`, `selfie.html`, `admin.js`, `index.html`, `style.css`, `supabase.sql`) e, se usar o CLI, a pasta `supabase/`.

Com o CLI do Supabase, os passos 2 e 3 são `supabase functions deploy geocode` e `supabase secrets set OPENCAGE_API_KEY=sua-chave`.

Como a função se comporta:

- Só atende **operador logado**. A chave pública (anon) sozinha não basta, porque a função confere o usuário do login.
- Recebe só o id da solicitação. As coordenadas são lidas do banco com a permissão do próprio operador: ele só consegue buscar endereço das solicitações dele.
- Cada solicitação consulta o OpenCage **uma vez**: o endereço fica guardado na linha, então reabrir a comparação não gasta cota. O plano de teste do OpenCage tem 2.500 consultas por dia e 1 por segundo.
- Pede ao OpenCage para não registrar a consulta (`no_record=1`), já que coordenadas são dados pessoais.
- Se a consulta falhar (cota, chave inválida, instabilidade), o painel mostra o motivo e um botão *Buscar o endereço de novo*. As coordenadas e o link do mapa aparecem de qualquer forma.
- Se aparecer "Invalid JWT" ao chamar a função (pode acontecer em projetos com as chaves de assinatura novas), desligue a opção *Verify JWT* da função nas configurações dela. É seguro: a função confere o login por conta própria.

Quanto vale a localização:

- É a posição que o **navegador do cliente informa**, com a permissão dele. Quem sabe mexer no aparelho ou usar extensões consegue falsificá-la. Trate como **evidência para a sua análise**, não como prova.
- Mostre sempre a **precisão**: em celular com GPS costuma ficar abaixo de 50 m; em computador ou sem GPS pode ser de vários quilômetros, e o painel avisa quando passa de 1 km.
- O **IP** vem do servidor (não é informado pelo cliente) e serve como segundo sinal. Ele pode apontar para a cidade da operadora, e VPN muda o resultado.
- A selfie ao vivo não traz GPS embutido; o local vem do pedido de permissão feito na hora da selfie.

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

## Publicar uma atualização (importante)

O navegador guarda JavaScript e CSS em cache (o GitHub Pages deixa os arquivos valerem por cerca de 10 minutos). Se o celular misturar um arquivo novo com um antigo, ou se o banco e os arquivos estiverem em versões diferentes, a selfie pode não gravar.

Por isso o rodapé do painel e da página do cliente mostra a **versão** (ex.: `v2026.10.17-c`). Para publicar uma mudança:

1. Suba os arquivos novos e, se o `supabase.sql` mudou, rode-o de novo no SQL Editor **antes** de testar.
2. Troque a versão em três lugares: `VERSAO` no `core.js` e o `?v=...` dos scripts e do CSS em `index.html`, `teste.html` e `selfie.html`. É isso que obriga o navegador a baixar os arquivos novos.
3. Espere 1 ou 2 minutos, abra o link numa aba anônima e confira o rótulo de versão no rodapé.

## Solução de problemas

- **"O sistema está sendo atualizado e não conseguiu gravar a sua selfie" (código `PGRST202`):** o banco não tem a função que o site chama, ou seja, banco e arquivos estão em versões diferentes. Rode o `supabase.sql` inteiro de novo e suba todos os arquivos atualizados.
- **"O link pode ter expirado ou já ter sido usado":** é o que o servidor responde quando o link já foi concluído, expirou, ou recusou as coordenadas. Gere um novo link. Quando a causa é outra, a linha cinza *Detalhe técnico* abaixo da mensagem diz qual.
- **O celular não pediu a localização ou se comporta como a versão antiga:** confira o rodapé. Se não houver versão, ou ela for diferente da publicada, o navegador está com arquivos velhos: abra numa aba anônima ou limpe os dados do site.
- **"Vire a cabeça para a sua esquerda/direita":** vale o **seu** lado, como se você se visse num espelho. Se virar para o lado contrário, a tela avisa. Cada tentativa sorteia o lado.
- **iPhone abrindo pelo WhatsApp:** o navegador embutido do WhatsApp pode bloquear câmera e localização. Peça ao cliente para abrir o link no Safari.
- **Selfies que não chegaram a ser concluídas** deixam arquivos na pasta do link. O botão *Excluir* do painel apaga todos eles junto com o registro.

## Limitações e cuidados

- **A prova de vida roda no navegador do cliente.** Quem sabe mexer em requisições consegue enviar qualquer JPEG com a chave pública e o token. O resultado "Rostos compatíveis" é um apoio à sua análise visual, não uma garantia. Para risco real de fraude (conta bancária, crédito), use verificação feita no servidor ou um serviço de liveness.
- **Deepfake, vídeo editado e câmera virtual** não são detectados.
- **LGPD:** selfie e documento são dados pessoais, a selfie é dado biométrico sensível, e a localização e o IP também são dados pessoais (o termo da página já os cita). O OpenCage recebe as coordenadas para devolver o endereço; avalie isso na sua política de privacidade. Para uso real você precisa de base legal, texto de consentimento revisado por um advogado (o texto da página é genérico), política de retenção e controle de acesso. O botão *Excluir* do painel apaga o registro e as imagens.
- **Retenção:** links que o cliente nunca concluiu podem deixar arquivos no storage. O `supabase.sql` traz um exemplo (comentado) de limpeza com `pg_cron`; as imagens precisam ser removidas pelo painel ou por uma Edge Function agendada.
- **Navegadores dentro de apps** (alguns navegadores embutidos do WhatsApp/Instagram, sobretudo no iPhone) podem bloquear a câmera. Se acontecer, peça ao cliente para abrir o link no Chrome ou no Safari.
- **Modelos:** o reconhecimento usa o face-api (modelo de 2017-2018), com precisão inferior à dos modelos atuais. Ajuste `LIMIAR_DISTANCIA` (hoje 0,5) em `app.js` e `admin.js` conforme os seus testes.
- **Dependências de CDN:** as versões estão fixadas (`face-api 1.7.15`, `supabase-js 2.118.0`). Para proteção extra contra adulteração do CDN, adicione `integrity` e `crossorigin="anonymous"` nas tags `<script>`. Hashes calculados a partir dos pacotes do npm (não consegui conferi-los contra o que o CDN serve, então teste antes de publicar; se a página parar de carregar com erro de *integrity* no console, remova o atributo):
  - `face-api.js`: `sha384-M5nePoB6/w/a9JhtegEibSLGiJy/+QMZZMfvcxjWVCQW/HPwrQ7i21V/Px/8AyVA`
  - `supabase.js`: `sha384-TcHRA3zBbn+Lexh5n+Oil4guNPOS3rjNDpGRAN46u/s/mB2IZ50ceC6TYDU2yvgK`
