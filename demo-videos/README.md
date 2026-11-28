# Vídeos de demonstração — Path tracing

Três vídeos MP4 (H.264, 1920×1080, 30 fps) gravados na **simulação** da Mesa XY
do Xadrez Voz + Mesa XY. O planejador, o executor, o traçado e o painel são os
mesmos usados com o Arduino; apenas o movimento dos motores é simulado.

| Arquivo | Duração | Demonstração |
| --- | --- | --- |
| `videos/01-cavalo-g1-f3.mp4` | 21,5 s | Cavalo `g1 → f3` com desobstrução: `g2 → g3`, `g1 → f3`, `g3 → g2` |
| `videos/02-roque.mp4` | 16,7 s | Roque pequeno `O-O`: rei `e1 → g1` e torre `h1 → f1` |
| `videos/03-peao-e2-e4.mp4` | 12,9 s | Peão `e2 → e4` em trajeto direto, com retorno a `0,0` |

Cada vídeo mostra:

- cartão de abertura com o lance demonstrado;
- tabuleiro virtual com o **traçado animado** (verde = peça principal,
  amarelo = desvio temporário, azul = devolução);
- cabeça magnética e ímã ligado apenas durante o transporte;
- painel **Mesa XY** com posição X/Y, estado do ímã, origem, sincronização,
  plano físico e log;
- etapa final com o plano concluído e a mesa em `0,0`.

As miniaturas estão em `posters/`.

## Como regravar

Pré-requisitos: servidor local do app, Edge/Chrome e `ffmpeg` com `libx264`.

```powershell
# 1. Em xadrez-voz-xy:
python server.py --port 8771 --no-browser

# 2. Na raiz do projeto:
node demo-videos/record-demos.mjs

# 3. Montar os MP4 (e apagar os frames brutos):
python demo-videos/assemble.py --clean
```

Para gravar apenas um cenário:

```powershell
node demo-videos/record-demos.mjs --only=cavalo
node demo-videos/record-demos.mjs --only=roque
node demo-videos/record-demos.mjs --only=peao
```

Os frames brutos ficam em `frames/` e são removidos após a montagem para
economizar espaço. O script `record-demos.mjs` usa o Edge em modo headless via
CDP e o `assemble.py` usa o `ffmpeg` encontrado no sistema.

## Observações

- Os vídeos não têm áudio; são demonstrativos do path tracing.
- O cenário do cavalo é o exemplo clássico de desobstrução: o peão de `g2` sai
  temporariamente para `g3`, o cavalo vai de `g1` para `f3` e o peão volta para
  `g2`.
- Em uma mesa física real, capturas, promoção e eventual assistência manual de
  roque continuam exigindo a confirmação do operador, como na interface.
