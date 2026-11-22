# Avisos de terceiros

## whisper.cpp

MIT License

Copyright (c) 2023-2024 Georgi Gerganov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## OpenAI Whisper

MIT License

Copyright (c) 2022 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## tiny-voca pt-BR

Model and code: https://huggingface.co/Haple/tiny-voca-ptbr-kokoro
Copyright (c) Aleph Santos (Haple) and contributors.
Licensed under the Apache License, Version 2.0.
Full license: `vendor/tinyvoca/LICENSE` and `models/tiny-voca/LICENSE`.

Local modifications in `vendor/tinyvoca/tiny_voca_ptbr/text.py`:
- subprocess calls to eSpeak NG now force UTF-8 decoding (Windows default
  cp1252 broke IPA output) and use `CREATE_NO_WINDOW` on Windows;
- the eSpeak version check accepts 1.5x instead of warning on 1.52-dev.

The ONNX weights are used as distributed.

## Kokoro-82M

The tiny-voca pt-BR model was trained on speech synthesized by Kokoro-82M:
https://huggingface.co/hexgrad/Kokoro-82M (Apache-2.0).

## eSpeak NG

eSpeak NG is distributed as a separate executable in `bin/espeak-ng/`.
Copyright (c) eSpeak NG contributors. Licensed under GPL-3.0-or-later.
Full license: `bin/espeak-ng/COPYING`.
Source: https://github.com/espeak-ng/espeak-ng

## numpy

Copyright (c) 2005-2024, NumPy Developers. BSD-3-Clause.
License text: `vendor/tts/numpy-*.dist-info/licenses/LICENSE.txt`.

## onnxruntime

Copyright (c) Microsoft Corporation. MIT License.
License text: `vendor/tts/onnxruntime-*.dist-info/METADATA`.

## Other vendored Python runtime packages

`vendor/tts/` also contains flatbuffers, protobuf and packaging, with their
license metadata in the corresponding `*.dist-info` directories.

## cburnett chess pieces

Colin M. L. Burnett — Creative Commons Attribution-ShareAlike 3.0.
https://creativecommons.org/licenses/by-sa/3.0/
