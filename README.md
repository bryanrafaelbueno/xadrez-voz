# ♞ Xadrez Voz + Mesa XY (versão local)

> **Esta é a versão local com Arduino, path tracing e recursos de
> acessibilidade.** O jogo, as regras, a voz com Whisper, a narração, a IA e a
> interface são os mesmos do Xadrez Voz. As adições são a aba **Mesa XY**
> (conexão Web Serial, posição da máquina, plano físico e traçado), o
> **descarte automático de capturas**, o **modo Mãos livres** e o
> **modo Acessível** com navegação por teclado.
>
> **Não publique esta pasta na Vercel.** Ela é uma cópia local; os arquivos
> `vercel.json`, `.vercelignore` e a pasta `api/` foram removidos. O servidor
> escuta apenas em `127.0.0.1`.

## Mesa XY — como usar

1. Dê duplo clique em **`start.bat`** (ou no atalho
   `..\ABRIR_XADREZ_XY.bat`). Use Chrome ou Edge.
2. Abra a aba **Mesa XY** no painel inferior.
3. Escolha **Arduino** ou **Simulação** e clique em conectar.
4. Com Arduino: escolha a porta, posicione a mesa em **0,0** e confirme a
   origem (ZERO). Depois ajuste as peças na posição do jogo e clique em
   **Confirmar mesa sincronizada**. Também é possível falar
   **“confirmar origem”** e **“mesa sincronizada”**.
5. Jogue normalmente (clique, texto ou voz). Só lances legais são aceitos. Cada
   lance é executado fisicamente e só depois aplicado no jogo.
6. O traçado aparece sobre o tabuleiro virtual, com as etapas
   **DESVIAR / JOGADA / DEVOLVER** no painel. Cada sub-movimento liga o ímã
   apenas em cima da peça e retorna a 0,0 ao soltar.
7. **Capturas sem remoção manual:** a máquina leva a peça capturada para um
   **ponto de descarte** na faixa externa ao tabuleiro e o app considera que
   ela já foi retirada. Não há painel de vagas/peças: o descarte é tratado como
   lixo. O lado pode ser a esquerda (padrão, faixa 0–50 mm) ou a direita
   (faixa 300–400 mm), em **Ajustes da mesa**. Coordenadas calculadas:
   **X=20 mm** à esquerda ou **X=380 mm** à direita; **Y=42,0 a 323,3 mm**,
   em pontos de 31,25 mm.

### Mãos livres e acessibilidade

- Ative **Mãos livres** no painel Voz. Depois da primeira permissão do
  microfone, o app fica ouvindo em modo contínuo: não é preciso apertar para
  falar em cada lance. **O navegador exige um primeiro clique/permissão**; isso
  não pode ser contornado por segurança.
- O modo **Acessível** (botão `A+` no topo) aumenta botões e textos, melhora o
  contraste e mostra a dica de teclado. No tabuleiro, use as **setas** para
  navegar, **Enter/Espaço** para selecionar/mover e **V** para falar.
- Perguntas de confirmação podem ser respondidas por voz: **“sim”**,
  **“confirmar”**, **“não”** ou **“cancelar”**. Na promoção, depois de trocar a
  peça física, diga **“peça trocada”**.
- Comandos físicos por voz: **“parar”**, **“ímã desligado”**,
  **“confirmar origem”** e **“mesa sincronizada”**.
- Falas que não são comandos de xadrez são **ignoradas em silêncio**: não
  aparecem avisos falados nem som de erro. Isso evita que a escuta contínua
  interrompa a partida por causa de conversas do ambiente.

Coordenadas físicas: área de trabalho de **0 a 400 mm**, tabuleiro de
**50 a 300 mm**, casas de **31,25 mm**, origem da máquina em **0,0**, firmware
do `Controle_XY.ino` a **80 passos/mm**. A configuração do canto físico do a1
fica em **Ajustes da mesa**.

Limitações físicas: a captura é automática e a peça descartada é considerada
retirada; a promoção ainda exige trocar a peça física quando o app pedir; o
roque tenta um plano automático e, se não couber, pede assistência manual.
Desfazer/nova partida não movem as peças físicas: o app avisa e pede para
sincronizar a mesa antes de voltar a executar lances. O tempo de cada lance
inclui o Whisper local (cerca de 1–2 s) e o deslocamento físico (alguns
segundos por sub-movimento).

**Regravar o `Controle_XY.ino` é recomendado** para que STOP e ZERO também
desliguem o ímã no firmware; a página envia `IMA,0` de qualquer forma.

---

Xadrez completo no navegador, controlado por **voz em português e inglês**, com
**Whisper local quantizado** (whisper.cpp), IA de xadrez integrada e modo para
dois jogadores.

![Xadrez Voz](docs/screenshot.png)

> **Versão local:** rode com `start.bat` ou `ABRIR_XADREZ_XY.bat`.
> O projeto não depende da Vercel e **não deve ser publicado lá**.

## Versão online (GitHub Pages)

**https://bryanrafaelbueno.github.io/xadrez-voz/**

A versão estática funciona sem instalar nada:

- Regras completas, tabuleiro, IA com Elo de 400 a 2400, dicas, PGN e FEN.
- Comandos por texto e por voz usando o **reconhecimento do navegador**
  (Chrome/Edge; esse caminho usa a nuvem do navegador).
- Narração pela voz **pt-BR disponível no navegador**, se houver.
- O modelo Whisper local, o servidor Python e a narração neural pt-BR **não
  rodam no GitHub Pages** (Pages é somente estático). Para a experiência
  completa, rode o projeto localmente com `start.bat`.

O repositório não versiona as pastas `bin/`, `models/` e `vendor/` por causa do
tamanho dos binários (Whisper, eSpeak e runtime da voz). A demo online não
precisa delas; a cópia local do projeto já as contém.

## Demonstrações de path tracing

A pasta `demo-videos/` contém três vídeos (cavalo com desobstrução, roque e peão)
e uma galeria para assistir: abra `demo-videos/index.html` ou os MP4s em
`demo-videos/videos/`.

## Destaques

- **Regras completas**: roques, en passant, promoção, xeque, xeque-mate,
  afogamento, regra dos 50 lances, repetição tripla e material insuficiente.
- **Voz local**: microfone → WAV 16 kHz → Whisper quantizado no seu computador.
  Nenhum áudio é enviado para servidores quando o Whisper local está ativo.
- **Narração em pt-BR**: voz neural local (tiny-voca) com opções feminina e
  masculina, além do teste “Ouvir voz” nos Ajustes.
- **Português e inglês**: interface, narração e reconhecimento nos dois idiomas.
- **IA de xadrez**: motor próprio em Web Worker (alpha-beta/PVS, tabela de
  transposição, quiescência, LMR) com **Elo aproximado de 400 a 2400**, dicas e
  barra de avaliação.
- **Modo 2 jogadores** e **modo contra a IA**, jogando com brancas ou pretas.
- **Comandos naturais**: “e2 e4”, “e dois e quatro”, “cavalo de g1 para f3”,
  “peão toma d5”, “captura em e5”, “roque pequeno”, “promover a dama”.
- **Escuta contínua** opcional, narração por voz, histórico, PGN e FEN.
- Funciona **offline** depois de iniciado (o fallback do navegador, se usado,
  pode acessar a nuvem).

## Início rápido (Windows)

1. Confira que a pasta `models/` tem os modelos e que `bin/whisper/` tem o
   whisper.cpp (ambos já acompanham este projeto).
2. Dê **duplo clique em `start.bat`**.
3. O navegador abre em `http://127.0.0.1:8765/` (ou na próxima porta livre).
4. Clique no microfone e permita o acesso quando o navegador pedir.

Requisitos: Windows x64, Python **3.14 x64** (o runtime da voz incluído em
`vendor/tts/` é para essa versão; com outra versão o reconhecimento continua
funcionando, mas a voz pt-BR local pode ficar indisponível), microfone e um
navegador Chromium/Edge/Chrome atualizado. Não é preciso instalar pacotes com
`pip`. Node.js é usado apenas para os testes, não para executar o app.

Se preferir iniciar manualmente:

```powershell
cd D:\Projetos\xadrez-voz
python server.py
```

Opções do servidor:

```powershell
python server.py --port 8765 --model base --threads 6
python server.py --cli        # sem servidor Whisper residente
python server.py --no-tts     # sem a voz local de narração
python server.py --no-browser
```

## Como jogar

- **Clique** em uma peça e depois na casa de destino, ou use a voz.
- **Microfone**: uma sessão escuta um comando e para. Ative **Escuta contínua**
  em Ajustes para o microfone voltar a ouvir depois de cada lance.
- **Atalho**: tecla `V` inicia/para a escuta (quando não está digitando).
- **Modo 2 jogadores**: os dois lados são controlados por clique/voz.
- **Dica**: o motor sugere um lance para o jogador da vez.
- **Elo da IA**: em Ajustes → **Elo da IA**, escolha de 400 a 2400 em passos de
  100. O valor altera a profundidade, o tempo de busca e a chance de erros da
  IA; a dica continua sempre forte. O Elo é uma **estimativa aproximada**.
- **Desfazer**: no modo IA, volta o lance seu e o da IA.
- **Narração**: em Ajustes, escolha entre voz **feminina** e **masculina** e use
  **Testar voz** para ouvir uma amostra. Também há amostras em
  `docs/voz-feminina.wav` e `docs/voz-masculina.wav`.
- **PGN/FEN**: botões na aba Lances copiam a partida/posição.

## Comandos de voz

| Português | English | Ação |
|---|---|---|
| `e2 e4` / `e dois e quatro` | `e2 e4` / `e two e four` | Lance por coordenadas |
| `cavalo de g1 para f3` | `knight from g1 to f3` | Peça + origem/destino |
| `cavalo f3` | `knight f3` | Peça + destino (se único) |
| `peão toma d5` | `pawn takes d5` | Captura |
| `captura em e5` | `capture on e5` | Captura no destino |
| `roque pequeno` / `roque grande` | `castle kingside` / `castle queenside` | Roques |
| `peão a7 a8 promover a dama` | `pawn a7 a8 promote to queen` | Promoção |
| `desfazer` | `undo` | Volta o lance |
| `nova partida` | `new game` | Reinicia |
| `dica` | `hint` | Sugere um lance |
| `girar tabuleiro` | `flip board` | Inverte o tabuleiro |
| `situação` | `status` | Fala o estado da partida |

O reconhecimento entende nomes de letras (“bê”, “efe”, “agá”), números por
extenso, alfabeto NATO (`echo two`), comandos parciais e pequenas falhas do
transcritor (por exemplo, “torre de a1 para oito” vira a1–a8).

## IA e Elo aproximado

O seletor **Ajustes → Elo da IA** vai de **400 a 2400**, em passos de 100. Cada
faixa ajusta três coisas no motor:

| Elo aprox. | Faixa | Profundidade | Tempo | Chance de lance aleatório |
|---|---|---:|---:|---:|
| 400–700 | Iniciante | 1–3 | 0,1–0,2 s | 45–22% |
| 800–1100 | Casual | 3–5 | 0,25–0,48 s | 17–7,5% |
| 1200–1500 | Clube | 5–7 | 0,6–1,1 s | 5,5–1,8% |
| 1600–1900 | Forte | 8–9 | 1,3–2,2 s | 1,2–0,3% |
| 2000–2400 | Mestre | 10–13 | 2,6–4,6 s | 0–0,2% |

O valor é uma **estimativa**: não é uma lista de rating oficial. A força real
depende da posição, do tempo de reflexão e do computador. O rodapé da partida
mostra “Contra a IA · Elo 1500”. No modo 2 jogadores o seletor fica oculto.

## Whisper local e modelos

O app usa `whisper.cpp` com modelos **q5_1** quantizados:

| Modelo | Tamanho | Tempo típico* | Uso |
|---|---:|---:|---|
| Base | 57 MB | ~2 s | padrão, rápido |
| Small | 181 MB | ~7 s | mais preciso com sotaques/ruído |

\* Intel i7-6700, comandos de 2–3 s, com o modelo já carregado. O primeiro uso
após iniciar pode levar alguns segundos a mais.

Você pode alternar em **Ajustes → Modelo Whisper**. Para baixar/restaurar os
modelos:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/download-models.ps1
```

O script baixa `ggml-base-q5_1.bin`, `ggml-small-q5_1.bin` e a voz pt-BR em
`models/tiny-voca/`. Também é possível usar qualquer `ggml-*.bin` colocado em
`models/`; ele aparecerá na lista.

### Fallback do navegador

Se o servidor Whisper não estiver ativo, o app tenta usar a API de reconhecimento
de voz do navegador (Chrome/Edge). Esse caminho **pode enviar áudio para a
nuvem** — por isso ele é indicado no selo da voz e no rodapé. Para uso 100%
local, mantenha o servidor Whisper rodando.

## Voz pt-BR da narração

A narração dos lances usa uma voz neural brasileira executada **localmente**
(tiny-voca pt-BR, 21 MB, 24 kHz), com vozes feminina e masculina. Ela não
depende das vozes instaladas no Windows — que, neste computador, eram apenas
em inglês.

- Modelo: `models/tiny-voca/`
- Runtime: `vendor/tts/` (numpy + onnxruntime) e `vendor/tinyvoca/`
- Fonemas: `bin/espeak-ng/` (eSpeak NG)
- Endpoint: `POST /api/tts` (texto → WAV)
- Tempo típico: **0,1–0,3 s** para gerar uma frase curta, depois que o modelo
  foi carregado; o áudio toca em seguida.

Em **Ajustes → Narração em voz alta**, escolha a voz e clique em **Testar voz**.
A narração em inglês continua usando a voz do navegador. Se a voz local não
estiver disponível, o app tenta a voz pt-BR do navegador (se existir) e mostra
isso no Ajustes; ele não lê português com uma voz inglesa.

Amostras prontas: `docs/voz-feminina.wav`, `docs/voz-masculina.wav` e a página
`docs/vozes.html` para ouvir as duas.

## Arquitetura

```
index.html            Interface
css/styles.css        Tema e layout responsivo
js/chess.js           Regras completas (0x88), FEN, SAN, PGN auxiliar
js/ai.js              Motor de xadrez (alpha-beta/PVS + avaliação)
js/ai-worker.js       Executa a IA em Web Worker
js/parser.js          Interpretador de comandos PT/EN
js/voice.js           Microfone, VAD, WAV 16 kHz, Whisper e fallback
js/pcm-worklet.js     Captura PCM via AudioWorklet
js/speech.js          Narração local pt-BR + Web Speech API
js/sound.js           Efeitos sonoros sintetizados
js/main.js            Controle do app
js/i18n.js            Textos PT/EN e descrição de lances
js/xy-table.js        Mesa XY, A*, descarte, Web Serial e simulação
server.py             HTTP local, Whisper e voz pt-BR
firmware/Controle_XY.ino      Firmware do Arduino (XY + ímã)
firmware/controle_xy.html    Página de teste manual da mesa
bin/whisper/          whisper.cpp (whisper-server, whisper-cli e DLLs)
bin/espeak-ng/        eSpeak NG (fonemas da narração)
models/               Whisper GGML + voz tiny-voca
vendor/tinyvoca/      Modelo/front-end da voz pt-BR (Apache-2.0)
vendor/tts/           numpy + onnxruntime para a voz local
tests/                Perft, parser, IA, voz e utilidades
```

O servidor mantém o `whisper-server` residente para evitar recarregar o modelo
a cada comando e cai automaticamente para o `whisper-cli` se necessário. A voz
pt-BR é carregada no próprio processo do servidor e usa apenas a máquina local.
Não é necessário rodar `pip install` no Python 3.14 x64.

## Testes

```powershell
node tests/perft.test.mjs
node tests/parser.test.mjs
node tests/ai.test.mjs
node tests/keys.test.mjs
python tests/tts_local.py
```

- **Perft**: cinco posições de referência, incluindo Kiwipete.
- **Parser**: comandos PT/EN, transcrições ruidosas, ambiguidade e promoção.
- **IA**: mate em 1, legalidade, auto-jogo e a escala de Elo 400–2400.
- **Chaves i18n**: confere se todas as chaves usadas existem.
- **Voz**: sintetiza frases nas duas vozes pt-BR e valida o áudio.

## Solução de problemas

**“Whisper local indisponível”** — confira `bin/whisper/whisper-server.exe` e os
modelos em `models/`. Veja também `whisper-server.log` na raiz do projeto.

**A porta 8765 está ocupada** — o servidor escolhe automaticamente a próxima
porta livre e mostra a URL no console.

**Microfone negado** — libere o microfone nas permissões do navegador
(ícone ao lado da barra de endereço) e recarregue a página.

**Sem voz pt-BR** — em Ajustes, confira o texto abaixo de “Narração em voz alta”.
Se disser “voz pt-BR local”, clique em **Testar voz**. Se disser que está
indisponível, confira `models/tiny-voca/`, `vendor/tts/` e `bin/espeak-ng/` e veja
o console do servidor. A narração em inglês usa a voz do navegador.

**A voz sai em inglês** — confirme que o idioma do app está em **PT** e que a
voz local apareceu em Ajustes. O narrador não usa voz inglesa para ler
português: se a voz local e a voz pt-BR do navegador faltarem, ele fica em
silêncio e o Ajustes mostra o aviso.

**A transcrição demora** — use o modelo Base em Ajustes. Ele é o padrão e leva
cerca de 2 s neste computador.

**Comando não reconhecido** — fale as coordenadas juntas (“e2 e4”) ou diga a
peça e a casa de destino (“cavalo f3”). Também é possível digitar o comando no
campo de texto.

**Primeiro uso do Windows** — se o SmartScreen/antivírus bloquear o
`whisper-server.exe`, permita o executável local.

**Python não encontrado** — instale o Python 3 em python.org e marque “Add
Python to PATH”, ou use `py -3 server.py`.

## Privacidade

- Com o Whisper local ativo, o áudio é processado na sua máquina e não sai dela.
- A narração pt-BR também é sintetizada localmente na versão desktop; apenas o
  texto do lance é enviado ao servidor local em `127.0.0.1`, nunca à internet.
- O áudio temporário é apagado do disco logo após a transcrição.
- O servidor local escuta apenas em `127.0.0.1`.
- O fallback do navegador pode usar serviços de nuvem do navegador; ele só é
  usado quando o Whisper do servidor falha e é identificado na interface.

## Créditos e licenças

- Peças de xadrez: **Colin M. L. Burnett**, licença CC BY-SA 3.0
  (via repositório do Lichess).
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp): MIT.
- Modelos [OpenAI Whisper](https://github.com/openai/whisper): MIT.
- Voz [tiny-voca pt-BR](https://huggingface.co/Haple/tiny-voca-ptbr-kokoro):
  Apache-2.0.
- [eSpeak NG](https://github.com/espeak-ng/espeak-ng): GPL-3.0-or-later.
- Motor de xadrez, interface e servidor deste projeto: feitos para este app.

Veja `CREDITS.md` e `THIRD_PARTY_NOTICES.md` para os textos completos.
