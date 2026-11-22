/**
 * Voice / text command parser for chess moves (Portuguese + English).
 *
 * Understands natural commands such as:
 *   "e2 e4", "e dois e quatro", "cavalo de g1 para f3",
 *   "peão toma d5", "captura em e5", "roque pequeno",
 *   "promover a dama", "desfazer", "nova partida", "dica".
 *
 * The parser is pure: all chess knowledge comes through `context`
 * (legal moves, board occupancy, side to move, current selection).
 */

import { nameToSq } from './chess.js';

const PIECE_WORDS = [
  ['cavalo', 'N'], ['cavalos', 'N'], ['caballo', 'N'], ['knight', 'N'], ['night', 'N'], ['horse', 'N'],
  ['bispo', 'B'], ['bispos', 'B'], ['bishop', 'B'], ['alfil', 'B'],
  ['torre', 'R'], ['torres', 'R'], ['rook', 'R'], ['tower', 'R'],
  ['dama', 'Q'], ['rainha', 'Q'], ['queen', 'Q'], ['reina', 'Q'],
  ['rei', 'K'], ['king', 'K'], ['rey', 'K'],
  ['peao', 'P'], ['peoes', 'P'], ['peon', 'P'], ['pawn', 'P'], ['pawns', 'P'],
  ['piao', 'P'], ['pioes', 'P'], ['pea', 'P'], ['pean', 'P'], ['pion', 'P'],
];

const PIECE_FROM_WORD = new Map(PIECE_WORDS);

const DIGIT_WORDS = new Map(Object.entries({
  um: '1', uma: '1', one: '1',
  dois: '2', duas: '2', dous: '2', two: '2',
  tres: '3', three: '3',
  quatro: '4', four: '4',
  cinco: '5', five: '5',
  seis: '6', six: '6',
  sete: '7', seven: '7',
  oito: '8', eight: '8',
}));

const LETTER_WORDS = new Map(Object.entries({
  a: 'a', alpha: 'a', alfa: 'a', ay: 'a',
  b: 'b', bee: 'b', be: 'b', bravo: 'b',
  c: 'c', cee: 'c', ce: 'c', see: 'c', sea: 'c', charlie: 'c',
  d: 'd', dee: 'd', de: 'd', delta: 'd',
  e: 'e', echo: 'e',
  f: 'f', ef: 'f', eff: 'f', efe: 'f', foxtrot: 'f',
  g: 'g', gee: 'g', ge: 'g', golf: 'g',
  h: 'h', aitch: 'h', aga: 'h', hotel: 'h',
}));

const CAPTURE_WORDS = new Set([
  'captura', 'capturar', 'captures', 'capture', 'captured', 'toma', 'tomar',
  'pega', 'pegar', 'come', 'comer', 'take', 'takes', 'x', 'ex', 'xe',
]);

const ACTION_PATTERNS = [
  { action: 'new', re: /\b(nova partida|novo jogo|nova rodada|new game|reiniciar|recomecar|restart|reset|comecar de novo|start over)\b/ },
  { action: 'undo', re: /\b(desfazer|desfaz|desfeito|voltar|voltar lance|voltar a jogada|voltar atras|undo|take ?back|retroceder|anular)\b/ },
  { action: 'hint', re: /\b(dica|sugestao|sugere|sugerir|melhor jogada|melhor lance|hint|help me|best move|what should i play)\b/ },
  { action: 'flip', re: /\b(girar tabuleiro|virar tabuleiro|inverter tabuleiro|girar o tabuleiro|flip board|flip the board|rotate board)\b/ },
  { action: 'resign', re: /\b(desistir|desisto|desistencia|abandonar|resign|i resign)\b/ },
  { action: 'status', re: /\b(situacao|status|como esta o jogo|como esta a partida|quem esta ganhando|who is winning|evaluation|avaliacao)\b/ },
  { action: 'repeat', re: /\b(repete|repetir|repeat|repita)\b/ },
];

export function stripAccents(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Normalize a raw transcript into a canonical, accent-free string. */
export function normalizeTranscript(text) {
  let s = stripAccents(text).toLowerCase();
  // castling written as O-O / 0-0
  s = s.replace(/\b0\s*-\s*0\s*-\s*0\b/g, ' ooo ');
  s = s.replace(/\b0\s*-\s*0\b/g, ' oo ');
  s = s.replace(/\bo\s*-\s*o\s*-\s*o\b/g, ' ooo ');
  s = s.replace(/\bo\s*-\s*o\b/g, ' oo ');
  s = s.replace(/[.,!?;:"'`´~^<>[\]{}()|/\\*_+=]/g, ' ');
  // split glued coordinates, including "g12f3" (g1 "to" f3)
  s = s.replace(/([a-h])([1-8])/g, ' $1 $2 ');
  // "torre dia 1" -> "torre de a 1" (common Whisper merge of "de a1")
  s = s.replace(/\bdia\s+([1-8])\b/g, ' de a $1 ');
  s = s.replace(/-/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Extract square names from a normalized transcript. */
export function extractSquares(normalized) {
  const tokens = normalized.split(' ').filter(Boolean);
  const squares = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const direct = /^[a-h][1-8]$/.exec(tok);
    if (direct) {
      squares.push(tok);
      continue;
    }
    const letter = LETTER_WORDS.get(tok);
    if (letter) {
      let j = i + 1;
      if (j < tokens.length && ['de', 'do', 'da'].includes(tokens[j])) j++;
      const digitTok = tokens[j];
      if (!digitTok) continue;
      const digit = DIGIT_WORDS.get(digitTok) || (/^[1-8]$/.test(digitTok) ? digitTok : null);
      if (digit) {
        squares.push(letter + digit);
        i = j;
      }
    }
  }
  return squares;
}

function detectPiece(normalized) {
  let cleaned = ' ' + normalized + ' ';
  // castling phrases contain king/queen words but are not piece moves
  cleaned = cleaned
    .replace(/roque (pequeno|curto|grande|longo|do rei|da dama)/g, ' ')
    .replace(/lado (do rei|da dama)/g, ' ')
    .replace(/kingside|queenside|short castle|long castle/g, ' ');
  const tokens = cleaned.split(' ');
  for (const tok of tokens) {
    if (PIECE_FROM_WORD.has(tok)) return PIECE_FROM_WORD.get(tok);
  }
  return null;
}

function detectCapture(normalized) {
  const tokens = normalized.split(' ');
  for (const tok of tokens) {
    if (CAPTURE_WORDS.has(tok)) return true;
    if (tok.startsWith('x') && /^x[a-h1-8]+$/.test(tok)) return true;
  }
  return /[a-h][1-8]\s*x\s*[a-h][1-8]/.test(normalized);
}

function detectPromotion(normalized) {
  const intent = /\b(promov\w*|promot\w*|promoc\w*|coroar|coroa|coroamento)\b/.test(normalized);
  return intent;
}

/** Queen/rook/bishop/knight explicitly named for a promotion. */
function detectPromotionPiece(normalized) {
  let cleaned = ' ' + normalized + ' ';
  cleaned = cleaned
    .replace(/roque (pequeno|curto|grande|longo|do rei|da dama)/g, ' ')
    .replace(/lado (do rei|da dama)/g, ' ')
    .replace(/kingside|queenside|short castle|long castle/g, ' ');
  for (const tok of cleaned.split(' ')) {
    const piece = PIECE_FROM_WORD.get(tok);
    if (piece && ['Q', 'R', 'B', 'N'].includes(piece)) return piece;
  }
  return null;
}

function detectCastle(normalized) {
  const n = ' ' + normalized + ' ';
  const long = /(roque|castle|castling|encroque)[a-z ]*\b(grande|longo|long|queenside|dama|lado da dama)\b/.test(n) ||
    /\b(grande|longo|long|queenside|lado da dama)\b[a-z ]*(roque|castle|castling)\b/.test(n) ||
    /\b(o o o|ooo|zero zero zero|grande roque)\b/.test(n);
  const short = /(roque|castle|castling)[a-z ]*\b(pequeno|curto|short|kingside|rei|lado do rei)\b/.test(n) ||
    /\b(pequeno|curto|short|kingside|lado do rei)\b[a-z ]*(roque|castle|castling)\b/.test(n) ||
    /\b(o o|oo|zero zero)\b/.test(n);
  const any = /\b(roque|castle|castling|encroque)\b/.test(n);
  if (long) return 'q';
  if (short) return 'k';
  if (any) return 'any';
  return null;
}

function validSquare(sq) {
  return typeof sq === 'string' && nameToSq(sq) >= 0;
}

const rankValue = (token) => {
  if (!token) return null;
  if (/^[1-8]$/.test(token)) return token;
  return DIGIT_WORDS.get(token) || null;
};

/**
 * Recover a destination whose file was dropped by the transcriber:
 *   "torre de a1 para 8"   -> a8
 *   "e sete, cinco"        -> e5
 */
function inferSecondSquare(normalized, square) {
  const tokens = normalized.split(' ').filter(Boolean);
  const file = square[0];
  const rank = square[1];
  let squareIndex = -1;
  for (let i = 0; i < tokens.length - 1; i++) {
    const letter = tokens[i].length === 1 ? tokens[i] : LETTER_WORDS.get(tokens[i]);
    if (letter !== file) continue;
    if (rankValue(tokens[i + 1]) !== rank) continue;
    squareIndex = i;
    break;
  }
  if (squareIndex < 0) return null;
  const afterRank = squareIndex + 2;
  const next = tokens[afterRank];
  const nextRank = rankValue(next);
  if (nextRank && nextRank !== rank) return file + nextRank;
  if (['para', 'to', 'ate'].includes(next)) {
    const targetRank = rankValue(tokens[afterRank + 1]);
    if (targetRank && targetRank !== rank) return file + targetRank;
  }
  return null;
}

function findActions(normalized) {
  const actions = [];
  for (const entry of ACTION_PATTERNS) {
    if (entry.re.test(normalized)) actions.push(entry.action);
  }
  return actions;
}

function boardPiece(context, square) {
  if (!context || !context.board) return null;
  return context.board[square] || null;
}

function isOwnPiece(piece, context) {
  if (!piece || !context) return false;
  return piece[0] === (context.turn === 'b' ? 'b' : 'w');
}

function moveEntry(m) {
  return {
    from: m.from,
    to: m.to,
    piece: m.piece,
    promotion: m.promotion || null,
    capture: !!m.capture,
    castle: m.castle || null,
  };
}

function uniqueBySource(candidates) {
  const seen = new Set();
  const out = [];
  for (const m of candidates) {
    if (seen.has(m.from + m.to)) continue;
    seen.add(m.from + m.to);
    out.push(moveEntry(m));
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Parse a command.
 * @param {string} text raw transcript
 * @param {object} context { turn:'w'|'b', moves:[...], board:{e2:'wP'}, selected:'e2'|null }
 */
export function parseCommand(text, context = {}) {
  const raw = String(text || '').trim();
  const normalized = normalizeTranscript(raw);
  const result = (obj) => ({ raw, normalized, ...obj });
  if (!normalized) return result({ type: 'invalid', reason: 'empty' });

  const actions = findActions(normalized);
  const castle = detectCastle(normalized);
  const promotionIntent = detectPromotion(normalized);
  const promotionPiece = detectPromotionPiece(normalized);
  const piece = detectPiece(normalized);
  const capture = detectCapture(normalized);
  let squares = extractSquares(normalized).filter(validSquare);
  if (squares.length === 1) {
    const inferred = inferSecondSquare(normalized, squares[0]);
    if (inferred && validSquare(inferred) && inferred !== squares[0]) {
      squares = [squares[0], inferred];
    }
  }
  const moves = Array.isArray(context.moves) ? context.moves : [];

  // Castling has priority (it contains king/queen words).
  if (castle) {
    return result({ type: 'action', action: 'castle', side: castle === 'any' ? null : castle, piece: 'K', capture: false });
  }

  // Simple game actions.
  if (actions.length) {
    // A move instruction may contain the word "voltar" etc. only by accident;
    // actions are explicit enough to win here.
    return result({ type: 'action', action: actions[0], piece, capture, squares });
  }

  // "promover a dama" with no destination -> choose a promotion piece.
  if (promotionIntent && !squares.length) {
    if (promotionPiece) {
      return result({ type: 'promotionChoice', piece: promotionPiece });
    }
    return result({ type: 'invalid', reason: 'promotion_piece_unknown' });
  }

  const pieceFilter = (m) => !piece || m.piece === piece;

  /* --------------------------- two squares: full move --------------------------- */
  if (squares.length >= 2) {
    let from = squares[0];
    let to = squares[1];

    const tryResolve = (a, b) => moves.filter((m) => m.from === a && m.to === b && pieceFilter(m));
    let candidates = tryResolve(from, to);
    if (!candidates.length) {
      const swapped = tryResolve(to, from);
      if (swapped.length) {
        candidates = swapped;
        [from, to] = [to, from];
      }
    }

    if (!candidates.length) {
      const hasPieceAtFrom = !!boardPiece(context, from);
      return result({
        type: 'invalid',
        reason: hasPieceAtFrom ? 'no_legal_move' : 'no_piece',
        from,
        to,
        piece,
        capture,
      });
    }

    if (candidates.length === 1) {
      return result({ type: 'move', ...moveEntry(candidates[0]) });
    }

    const promotions = candidates.filter((m) => m.promotion);
    if (promotions.length === candidates.length) {
      if (promotionPiece) {
        const chosen = candidates.find((m) => m.promotion === promotionPiece);
        if (chosen) return result({ type: 'move', ...moveEntry(chosen) });
      }
      return result({
        type: 'needsPromotion',
        from,
        to,
        candidates: candidates.map(moveEntry),
      });
    }

    return result({ type: 'ambiguous', reason: 'multiple_moves', from, to, candidates: uniqueBySource(candidates) });
  }

  /* ---------------------------- one square: partial ---------------------------- */
  if (squares.length === 1) {
    const square = squares[0];
    const own = boardPiece(context, square);
    const ownPiece = isOwnPiece(own, context);

    // "cavalo g1" -> select the piece
    if (!capture && ownPiece && (!piece || own[1] === piece)) {
      return result({ type: 'select', square, piece: own ? own[1] : piece });
    }

    // target resolved from the current selection first
    if (context.selected) {
      const fromSelected = moves.filter((m) => m.from === context.selected && m.to === square && pieceFilter(m));
      if (fromSelected.length === 1) return result({ type: 'move', ...moveEntry(fromSelected[0]) });
      if (fromSelected.length > 1) {
        const promoMoves = fromSelected.filter((m) => m.promotion);
        if (promoMoves.length === fromSelected.length) {
          if (promotionPiece) {
            const chosen = promoMoves.find((m) => m.promotion === promotionPiece);
            if (chosen) return result({ type: 'move', ...moveEntry(chosen) });
          }
          return result({
            type: 'needsPromotion',
            from: context.selected,
            to: square,
            candidates: promoMoves.map(moveEntry),
          });
        }
        return result({ type: 'ambiguous', reason: 'multiple_moves', target: square, candidates: uniqueBySource(fromSelected) });
      }
    }

    let candidates = moves.filter((m) => m.to === square && pieceFilter(m));
    if (capture) {
      const captures = candidates.filter((m) => m.capture);
      if (captures.length) candidates = captures;
    }

    if (candidates.length === 1) return result({ type: 'move', ...moveEntry(candidates[0]) });
    if (candidates.length > 1) {
      const promotions = candidates.filter((m) => m.promotion);
      if (promotions.length === candidates.length) {
        const sources = new Set(candidates.map((m) => m.from));
        if (promotionPiece) {
          const chosen = candidates.find((m) => m.promotion === promotionPiece);
          if (chosen) return result({ type: 'move', ...moveEntry(chosen) });
        }
        if (sources.size === 1) {
          return result({
            type: 'needsPromotion',
            to: square,
            from: candidates[0].from,
            candidates: promotions.map(moveEntry),
          });
        }
      }
      return result({ type: 'ambiguous', reason: 'multiple_moves', target: square, candidates: uniqueBySource(candidates) });
    }

    if (ownPiece && (!piece || own[1] === piece)) {
      return result({ type: 'select', square, piece: own ? own[1] : piece });
    }
    return result({
      type: 'invalid',
      reason: capture ? 'no_capture_available' : 'no_legal_move',
      to: square,
      piece,
      capture,
    });
  }

  /* ------------------------------ no square given ----------------------------- */
  if (promotionIntent && promotionPiece) {
    return result({ type: 'promotionChoice', piece: promotionPiece });
  }
  if (piece) {
    return result({ type: 'invalid', reason: 'squares_missing', piece });
  }
  if (capture) {
    return result({ type: 'invalid', reason: 'squares_missing' });
  }
  return result({ type: 'invalid', reason: 'unknown_command' });
}

/** Named promotion piece from a short utterance ("dama", "queen", "cavalo"...). */
export function parsePromotionPiece(text) {
  const normalized = normalizeTranscript(text);
  const piece = detectPiece(normalized);
  return ['Q', 'R', 'B', 'N'].includes(piece) ? piece : null;
}

/** Localized error message keys are resolved by the UI. */
export const PARSE_REASONS = [
  'empty', 'unknown_command', 'squares_missing', 'no_legal_move', 'no_piece',
  'no_capture_available', 'promotion_piece_unknown', 'multiple_moves',
];
