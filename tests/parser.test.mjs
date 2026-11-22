import { Chess, moveFrom, moveTo, movePromotion, moveFlags, FLAG_CAPTURE, FLAG_KCASTLE, FLAG_QCASTLE, nameToSq, sqToName } from '../js/chess.js';
import { parseCommand } from '../js/parser.js';

function contextFor(game, selected = null) {
  const board = {};
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) continue;
    const p = game.board[sq];
    if (!p) continue;
    board[sqToName(sq)] = (p > 0 ? 'w' : 'b') + 'PNBRQK'[Math.abs(p) - 1];
  }
  const moves = game.generateMoves(false).map((m) => {
    const piece = Math.abs(game.board[moveFrom(m)]);
    const flags = moveFlags(m);
    return {
      from: sqToName(moveFrom(m)),
      to: sqToName(moveTo(m)),
      piece: 'PNBRQK'[piece - 1],
      promotion: movePromotion(m) ? 'PNBRQK'[movePromotion(m) - 1] : null,
      capture: !!(flags & FLAG_CAPTURE),
      castle: flags & FLAG_KCASTLE ? 'k' : flags & FLAG_QCASTLE ? 'q' : null,
    };
  });
  return { turn: game.turn === 1 ? 'w' : 'b', moves, board, selected };
}

let failures = 0;
function expect(name, text, game, expected, selected = null) {
  const parsed = parseCommand(text, contextFor(game, selected));
  let ok = true;
  for (const [key, value] of Object.entries(expected)) {
    const actual = parsed[key];
    if (value instanceof RegExp ? !value.test(String(actual)) : actual !== value) ok = false;
  }
  if (!ok) {
    failures++;
    console.log(`FAIL ${name} :: "${text}" ->`, JSON.stringify(parsed));
  } else {
    console.log(`PASS ${name}`);
  }
  return parsed;
}

const start = new Chess();
expect('coordinate e2 e4', 'e2 e4', start, { type: 'move', from: 'e2', to: 'e4' });
expect('spoken PT e dois e quatro', 'e dois e quatro', start, { type: 'move', from: 'e2', to: 'e4' });
expect('accented é dois é quatro', 'é dois é quatro', start, { type: 'move', from: 'e2', to: 'e4' });
expect('natural PT pawn', 'peão de e2 para e4', start, { type: 'move', from: 'e2', to: 'e4' });
expect('natural EN knight', 'knight from g1 to f3', start, { type: 'move', from: 'g1', to: 'f3' });
expect('whisper g12f3', 'Night from G12F3.', start, { type: 'move', from: 'g1', to: 'f3' });
expect('piece + target', 'cavalo f3', start, { type: 'move', from: 'g1', to: 'f3' });
expect('piece only target queen', 'dama d2', start, { type: 'invalid' });
expect('select e2', 'peão e2', start, { type: 'select', square: 'e2' });
expect('selection then target', 'e4', start, { type: 'move', from: 'e2', to: 'e4' }, 'e2');
expect('castle short PT', 'roque pequeno', start, { type: 'action', action: 'castle', side: 'k' });
expect('castle O-O', 'O-O', start, { type: 'action', action: 'castle', side: 'k' });
expect('castle long EN', 'castle queenside', start, { type: 'action', action: 'castle', side: 'q' });
expect('new game', 'nova partida', start, { type: 'action', action: 'new' });
expect('undo', 'desfazer', start, { type: 'action', action: 'undo' });
expect('hint', 'dica', start, { type: 'action', action: 'hint' });
expect('promotion choice', 'promover a dama', start, { type: 'promotionChoice', piece: 'Q' });
expect('unknown', 'bom dia tudo bem', start, { type: 'invalid', reason: 'unknown_command' });

// ambiguous: knights b1 and f3 can both reach d2
const amb = new Chess('4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1');
const ambParsed = expect('ambiguous target', 'cavalo d2', amb, { type: 'ambiguous' });
if (ambParsed.candidates && ambParsed.candidates.length === 2) console.log('PASS ambiguous lists 2 sources');
else { failures++; console.log('FAIL ambiguous candidate list'); }

// capture: white pawn e4 can take d5
const cap = new Chess('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
expect('capture target', 'captura em d5', cap, { type: 'move', from: 'e4', to: 'd5' });
expect('pawn takes', 'peão toma d5', cap, { type: 'move', from: 'e4', to: 'd5' });
expect('capture coordinates', 'e4 x d5', cap, { type: 'move', from: 'e4', to: 'd5' });

// promotion: white pawn a7 -> a8, queen named
const promo = new Chess('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
expect('promotion via promote', 'peão a7 a8 promover a dama', promo, { type: 'move', from: 'a7', to: 'a8', promotion: 'Q' });
expect('promotion trailing piece', 'peão a7 a8 dama', promo, { type: 'move', from: 'a7', to: 'a8', promotion: 'Q' });
expect('promotion needs choice', 'a7 a8', promo, { type: 'needsPromotion' });

// en passant by voice
const ep = new Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
expect('en passant', 'peão e5 d6', ep, { type: 'move', from: 'e5', to: 'd6' });

// english spoken letters
expect('english letters', 'e two e four', start, { type: 'move', from: 'e2', to: 'e4' });
expect('nato letters', 'echo two echo four', start, { type: 'move', from: 'e2', to: 'e4' });
expect('pt letter names', 'ê dois ê quatro', start, { type: 'move', from: 'e2', to: 'e4' });

// noisy Whisper output recoveries
expect('homophone piao', 'Pião toma d5', cap, { type: 'move', from: 'e4', to: 'd5' });
expect('homophone pea', 'Peã toma d5', cap, { type: 'move', from: 'e4', to: 'd5' });
expect('dropped target file', 'Torre de a1 para oito', new Chess('7k/8/8/8/8/8/8/R3K3 w - - 0 1'), { type: 'move', from: 'a1', to: 'a8' });
expect('dropped both files', 'Torre dia 1 para 8', new Chess('7k/8/8/8/8/8/8/R3K3 w - - 0 1'), { type: 'move', from: 'a1', to: 'a8' });
expect('second square missing its letter', 'e sete cinco', new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1'), { type: 'move', from: 'e7', to: 'e5' });
expect('queen target recovered by parsing', 'Dama de d1 para h5', new Chess('4k3/8/8/8/8/8/8/3QK3 w - - 0 1'), { type: 'move', from: 'd1', to: 'h5' });

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PARSER TESTS PASSED');
process.exit(failures ? 1 : 0);
