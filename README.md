# 📸 Postar no Instagram (WhatsApp + site)

Publica fotos e vídeos no Instagram do trabalho de dois jeitos:

- **Bot do WhatsApp:** você manda a foto com o texto da publicação na legenda e ele publica sozinho
- **Site:** você abre no celular, escolhe as fotos, escreve a legenda e toca em **Publicar**

Os dois podem ficar ligados ao mesmo tempo, ou só um deles.

## Como usar o bot do WhatsApp

| Você manda | O bot faz |
|---|---|
| 1 foto com legenda | Publica a foto com esse texto |
| 1 vídeo com legenda | Publica como **Reels** |
| Várias fotos/vídeos de uma vez (até 10) | Publica um **carrossel**, usando a legenda que você escreveu |
| Foto(s)/vídeo(s) com a legenda `story` | Publica **só no Story** (cada arquivo vira um Story) |
| Foto(s)/vídeo(s) com a legenda `story + texto` | Publica **no feed** (com o texto) **e no Story** |
| Foto sem legenda e, logo depois, um texto | Usa o texto como legenda |
| `cancelar` | Descarta o que ainda não foi publicado |
| Qualquer outro texto | Mostra a ajuda |

O bot espera 15 segundos depois da última foto (`WA_ALBUM_WAIT_SECONDS`) antes de publicar. Esse tempo serve para juntar as fotos de um álbum. Depois ele responde com o link do post. Só os números em `WA_ALLOWED_NUMBERS` conseguem publicar; os outros são ignorados.

As fotos ficam no servidor por 24h e depois são apagadas.

### No iPhone

- **Bot:** não precisa instalar nada além do WhatsApp. Salve o número do bot nos contatos e converse com ele normalmente.
  - Dá para mandar a foto direto do app **Fotos**: *Compartilhar → WhatsApp → bot*. Escreva o texto da publicação no campo de legenda antes de enviar.
- **Formato HEIC:** prefira enviar como **foto** normal. Assim o WhatsApp converte o HEIC do iPhone para JPEG.
  - Se você enviar "como documento", a foto só funciona se já estiver em JPEG. Se estiver em HEIC, o bot avisa. Para o iPhone tirar fotos em JPEG: *Ajustes → Câmera → Formatos → Mais Compatível*.
- **Site:** no Safari, abra o endereço do app e toque em *Compartilhar → Adicionar à Tela de Início*. Ele vira um ícone que abre como um app.

---

## 1. Instagram

1. A conta do trabalho precisa ser **Profissional** (Empresa ou Criador de conteúdo).
   No app do Instagram: *Configurações → Tipo de conta e ferramentas → Mudar para conta profissional*.
2. Crie um app em <https://developers.facebook.com/apps> → tipo **Empresa**.
3. Adicione o produto **Instagram** → *API setup with Instagram login*.
4. Em *Generate access tokens*, adicione a conta do trabalho e clique em **Generate token**.
   As permissões necessárias são `instagram_business_basic` e `instagram_business_content_publish`.
5. Copie o token, que vai em `IG_ACCESS_TOKEN`.

> O token do Instagram dura cerca de 60 dias. O app tenta renová-lo sozinho ao iniciar e uma vez por dia (veja o log *Token do Instagram renovado*).
> Se o app ficar parado por mais de 60 dias, gere um token novo. Para renovar manualmente:
> `curl "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=SEU_TOKEN"`

## 2. WhatsApp (no mesmo app da Meta)

1. No app que você criou, adicione o produto **WhatsApp**.
2. **Número do bot:**
   - Para testar, a Meta oferece um número de teste gratuito. Cadastre o seu celular como destinatário em *API Setup → To*.
   - Para uso definitivo, adicione um número próprio. Use um chip que **não** esteja em uso no app WhatsApp comum.
3. Copie o **Phone number ID** de *API Setup*. Ele vai em `WA_PHONE_NUMBER_ID`.
4. **Token permanente:** o token que aparece em *API Setup* vence em 24h.
   - Para ter um token permanente, crie um usuário do sistema. No Business Manager: *Configurações do negócio → Usuários do sistema → Adicionar*.
   - Dê a ele acesso ao app e gere um token com as permissões `whatsapp_business_messaging` e `whatsapp_business_management`.
   - O token vai em `WA_ACCESS_TOKEN`.
5. Copie o **App secret** de *App settings → Basic*. Ele vai em `WA_APP_SECRET`.
6. Configure o **webhook**, depois que o app estiver no ar (passo 3):
   - Em *WhatsApp → Configuration → Webhook*, coloque:
     - Callback URL: `https://SEU-APP/webhook`
     - Verify token: o mesmo valor que você colocou em `WA_VERIFY_TOKEN`
   - Clique em **Verify and save** e depois assine o campo **messages**.
7. Coloque seu número (com DDI e DDD, ex.: `5511999999999`) em `WA_ALLOWED_NUMBERS`.

> Custo: as mensagens que o bot manda são respostas suas, dentro da janela de 24h de atendimento, e por isso são gratuitas.

## 3. Hospedagem (precisa ser pública)

O app precisa estar na internet por dois motivos: o Instagram **baixa a foto de um link público** e o WhatsApp precisa chamar o webhook. Algumas opções fáceis:

- **Render** (render.com): *New → Blueprint*, escolha este repositório. O `render.yaml` já configura tudo e pede as variáveis.
  O `WA_VERIFY_TOKEN` é gerado sozinho; copie o valor no painel do Render para usar no passo 2.6.
- **Railway** (railway.app) ou **Fly.io**: funcionam do mesmo jeito

Configure as variáveis de ambiente conforme o `.env.example`. Em `PUBLIC_BASE_URL`, coloque o endereço do app, ex.: `https://meu-app.onrender.com`.

> No plano gratuito do Render, o app "dorme" quando fica parado. A primeira mensagem depois de um tempo pode demorar cerca de 1 minuto para ser processada.

## 4. Rodar localmente para testar

```bash
npm install
cp .env.example .env      # preencha e coloque DRY_RUN=true
npm start                 # site em http://localhost:3000
```

Com `DRY_RUN=true`, o app processa as fotos e responde no WhatsApp, mas **não publica nada no Instagram**.

## Limites do Instagram

- Até 100 publicações pela API a cada 24h
- Fotos são convertidas para JPEG automaticamente
- Vídeos precisam estar em MP4 ou MOV (o padrão da câmera do celular); Reels de 3 s a 15 min, vídeos de carrossel de até 60 s
- O Instagram leva de 1 a 3 minutos para processar um vídeo
- Story não tem legenda; fotos não são cortadas (o Instagram ajusta à tela, ideal 9:16); vídeos de Story até 60 s
- O WhatsApp comprime os vídeos; para manter a qualidade, envie **como documento**
- No carrossel, todas as fotos ficam com a proporção da primeira (o app recorta mantendo a parte mais importante)
- Legenda de no máximo 2.200 caracteres e 30 hashtags
