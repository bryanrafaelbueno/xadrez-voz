# Créditos

## Peças de xadrez

As peças SVG em `assets/pieces/` são o conjunto **cburnett**, criado por
**Colin M. L. Burnett** e distribuído sob a licença
[Creative Commons Attribution-ShareAlike 3.0 (CC BY-SA 3.0)](https://creativecommons.org/licenses/by-sa/3.0/).

- Autor: Colin M. L. Burnett
- Origem: conjunto “cburnett” usado pelo Lichess
  (https://github.com/lichess-org/lila/tree/master/public/piece/cburnett)
- Alterações: nenhuma; os arquivos são usados como fornecidos.

## Reconhecimento de voz

- `whisper.cpp` — Georgi Gerganov e colaboradores — licença MIT.
- Modelos OpenAI Whisper — OpenAI — licença MIT.

## Narração em português do Brasil

- **tiny-voca pt-BR** — Aleph Santos (Haple) — Apache-2.0.
  Modelo de 4,5 milhões de parâmetros, 24 kHz, treinado a partir da voz
  professora Kokoro-82M. Página:
  https://huggingface.co/Haple/tiny-voca-ptbr-kokoro
- **eSpeak NG** — projeto eSpeak NG e colaboradores — GPL-3.0-or-later.
  Usado apenas para gerar fonemas a partir do texto.
- **Kokoro-82M** — hexgrad — Apache-2.0 (voz professora do modelo tiny-voca).
- **numpy** (BSD-3-Clause) e **onnxruntime** (MIT), distribuídos em
  `vendor/tts/` para executar a voz localmente.

## Aplicação

Interface, servidor local, interpretador de comandos, motor de xadrez e
integração de voz foram escritos especificamente para o Xadrez Voz.

Veja também `THIRD_PARTY_NOTICES.md`, `vendor/tinyvoca/LICENSE`,
`models/tiny-voca/LICENSE` e `bin/espeak-ng/COPYING`.
