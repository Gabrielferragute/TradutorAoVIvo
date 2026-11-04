# Legenda PT-BR ao vivo (Extensão Chrome)

Extensão para Google Chrome (Manifest V3) que captura o áudio da aba atual, transcreve a fala em inglês e traduz para português do Brasil em tempo real, sobrepondo uma legenda limpa e responsiva diretamente no vídeo.

Desenvolvida especialmente para acompanhar cursos e treinamentos técnicos da IBM (Mainframe, COBOL, JCL, z/OS, Zowe, VS Code), preservando termos consagrados do ecossistema de TI sem traduções literais indesejadas (ex.: *job*, *dataset*, *copybook*, *spool*).

---

## 🚀 Como Instalar

1. Abra o Google Chrome e acesse `chrome://extensions/`.
2. No canto superior direito, ative a chave **"Modo do desenvolvedor"**.
3. Clique no botão **"Carregar sem compactação"** (Load unpacked).
4. Selecione a pasta deste projeto:  
   `Extensao tradutor`
5. A extensão **Legenda PT-BR ao vivo** aparecerá na sua lista de extensões.
6. (Recomendado) Clique no ícone de "quebra-cabeça" na barra de ferramentas do Chrome e **fixe** a extensão para acesso rápido.

---

## 🔑 Configuração da Chave de API (Google Gemini Gratuito)

A extensão utiliza a API multimodal do Google Gemini (`gemini-2.0-flash`), que transcreve e traduz o áudio diretamente em uma única etapa ultrarrápida.

1. Obtenha sua chave gratuita no [Google AI Studio](https://aistudio.google.com/apikey).
2. Clique com o **botão direito** no ícone da extensão e selecione **"Opções"** (ou abra `chrome://extensions` e clique em *Detalhes > Opções da extensão*).
3. Cole a sua chave no campo **Chave da API do Google Gemini** e clique em **"Salvar Chave"**.
4. Clique em **"Testar Conexão"** para validar se o modelo está respondendo corretamente.

---

## 🎬 Como Usar

1. Abra qualquer página contendo um vídeo com áudio em inglês (ex.: Cognitive Class, Coursera, YouTube).
2. Clique no ícone da extensão na barra de ferramentas:
   - O ícone mudará para azul com a etiqueta **"ON"**.
   - O texto **"Legenda ativa: aguardando fala…"** aparecerá sobre o vídeo.
3. Dê play no vídeo: assim que houver fala perceptível, as legendas traduzidas surgirão na tela.
4. Para desligar, basta clicar novamente no ícone da extensão.

### ⌨️ Atalhos de Teclado
- **`Alt + Shift + H`**: Oculta ou exibe a legenda na tela instantaneamente, sem interromper a captura do áudio.  
  *(Você pode personalizar este atalho em `chrome://extensions/shortcuts`)*.

---

## ⚙️ Opções e Ajustes

Na página de **Opções** da extensão, você pode personalizar:
- **Tamanho da fonte**: Ajuste de 12px a 48px com pré-visualização ao vivo na tela.
- **Limiar de silêncio (RMS)**: Ajusta a sensibilidade do microfone/áudio.
- **Duração do trecho**: Otimizado para ~2.2s a 4.5s por trecho para latência reduzida (~3 segundos totais).

---

## 🛠️ Arquitetura e Decisões Técnicas

- **Chrome Manifest V3**: Utiliza Service Worker (`background.js`) para gerenciar eventos e permissões sob demanda.
- **Captura sem perda de áudio**: Captura via `chrome.tabCapture.getMediaStreamId`, consumida num **Offscreen Document** (`offscreen.js`) com roteamento de volta para os alto-falantes (`audioCtx.destination`).
- **Detecção de Voz (VAD)**: Algoritmo de corte inteligente por pausa baseado no nível RMS do sinal de áudio, evitando cortar palavras ao meio.
- **1-Step Gemini Multimodal**: Envia o áudio WebM diretamente para a API do Gemini via `inlineData`, eliminando a necessidade de encadear chamadas separadas de Whisper + GPT.
- **Fullscreen & Top Layer**: O container da legenda utiliza `popover="manual"` em Shadow DOM fechado, garantindo que a legenda continue visível mesmo quando o player entra em modo tela cheia.

---

## ❓ Perguntas Frequentes & Solução de Problemas

- **"Legenda ativa: aguardando fala..." e nada aparece?**
  - Verifique se o volume no player do vídeo está audível (se o player estiver quase mudo, o VAD considera silêncio).
  - Confirme se a chave de API está salva e ativa em *Opções > Testar Conexão*.
- **O ícone fica com "!" vermelho ao clicar?**
  - O navegador Chrome proíbe extensões de capturarem abas internas do sistema (ex.: `chrome://extensions`, `chrome://newtab` ou a Chrome Web Store). Abra uma aba de vídeo comum (ex.: YouTube) para ativar.
