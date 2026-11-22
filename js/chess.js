/**
 * Chess rules engine — 0x88 board representation.
 * Full rules: castling, en passant, promotion, check/checkmate,
 * stalemate, 50-move rule, threefold repetition and insufficient material.
 *
 * Pure ES module, no dependencies. Used by the UI and by the AI worker.
 */

export const WHITE = 1;
export const BLACK = -1;

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const FLAG_CAPTURE = 1;
export const FLAG_DOUBLE = 2;
export const FLAG_EP = 4;
export const FLAG_KCASTLE = 8;
export const FLAG_QCASTLE = 16;
export const FLAG_PROMOTION = 32;

export const FILES = 'abcdefgh';
export const PIECE_LETTERS = { [PAWN]: 'P', [KNIGHT]: 'N', [BISHOP]: 'B', [ROOK]: 'R', [QUEEN]: 'Q', [KING]: 'K' };
const LETTER_PIECES = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

const KNIGHT_OFFSETS = [33, 31, 18, 14, -14, -18, -31, -33];
const BISHOP_DIRS = [17, 15, -15, -17];
const ROOK_DIRS = [16, -16, 1, -1];
const KING_OFFSETS = [16, -16, 1, -1, 17, 15, -15, -17];

export const onBoard = (sq) => (sq & 0x88) === 0;
export const sqToName = (sq) => FILES[sq & 15] + ((sq >> 4) + 1);
export function nameToSq(name) {
  if (typeof name !== 'string' || name.length < 2) return -1;
  const f = FILES.indexOf(name[0].toLowerCase());
  const r = parseInt(name[1], 10) - 1;
  if (f < 0 || r < 0 || r > 7) return -1;
  return r * 16 + f;
}

/* ------------------------------------------------------------------ */
/* Packed moves: from | to<<7 | promo<<14 | flags<<17                  */
/* ------------------------------------------------------------------ */
export const makeMoveInt = (from, to, promo = 0, flags = 0) => from | (to << 7) | (promo << 14) | (flags << 17);
export const moveFrom = (m) => m & 127;
export const moveTo = (m) => (m >> 7) & 127;
export const movePromotion = (m) => (m >> 14) & 7;
export const moveFlags = (m) => (m >> 17) & 63;

export function moveToUci(m) {
  const promo = movePromotion(m);
  return sqToName(moveFrom(m)) + sqToName(moveTo(m)) + (promo ? PIECE_LETTERS[promo].toLowerCase() : '');
}

export function uciToMove(uci) {
  if (typeof uci !== 'string') return null;
  const s = uci.trim().toLowerCase();
  const from = nameToSq(s.slice(0, 2));
  const to = nameToSq(s.slice(2, 4));
  if (from < 0 || to < 0) return null;
  const promo = s.length > 4 ? LETTER_PIECES[s[4]] || 0 : 0;
  return { from, to, promo };
}

/* ------------------------------------------------------------------ */
/* Deterministic Zobrist keys                                          */
/* ------------------------------------------------------------------ */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

const rand32 = mulberry32(0x1f2e3d4c);
const Z_PIECE_A = new Uint32Array(12 * 128);
const Z_PIECE_B = new Uint32Array(12 * 128);
for (let i = 0; i < 12 * 128; i++) {
  Z_PIECE_A[i] = rand32();
  Z_PIECE_B[i] = rand32();
}
const Z_CASTLE_A = new Uint32Array(16);
const Z_CASTLE_B = new Uint32Array(16);
for (let i = 0; i < 16; i++) {
  Z_CASTLE_A[i] = rand32();
  Z_CASTLE_B[i] = rand32();
}
const Z_EP_A = new Uint32Array(8);
const Z_EP_B = new Uint32Array(8);
for (let i = 0; i < 8; i++) {
  Z_EP_A[i] = rand32();
  Z_EP_B[i] = rand32();
}
const Z_TURN_A = rand32();
const Z_TURN_B = rand32();

const zIndex = (piece) => ((piece > 0 ? 0 : 6) + Math.abs(piece) - 1) * 128;

/* ------------------------------------------------------------------ */
/* Chess class                                                         */
/* ------------------------------------------------------------------ */
export class Chess {
  constructor(fen = START_FEN) {
    this.load(fen);
  }

  load(fen = START_FEN) {
    this.board = new Int8Array(128);
    this.turn = WHITE;
    this.castling = 0;
    this.ep = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.kings = [-1, -1];
    this.history = [];
    this.positionHashes = [];
    this.lastError = null;

    const parts = String(fen).trim().split(/\s+/);
    if (parts.length < 4) {
      this.lastError = 'FEN inválida';
      fen = START_FEN;
      return this.load(fen);
    }
    const rows = parts[0].split('/');
    if (rows.length !== 8) {
      this.lastError = 'FEN inválida';
      return this.load(START_FEN);
    }
    for (let r = 0; r < 8; r++) {
      let file = 0;
      const rank = 7 - r;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') {
          file += Number(ch);
        } else {
          const upper = ch.toUpperCase();
          const type = LETTER_PIECES[upper.toLowerCase()];
          if (!type || file > 7) {
            this.lastError = 'FEN inválida';
            return this.load(START_FEN);
          }
          const piece = ch === upper ? type : -type;
          const sq = rank * 16 + file;
          this.board[sq] = piece;
          if (type === KING) this.kings[piece > 0 ? 0 : 1] = sq;
          file++;
        }
      }
      if (file !== 8) {
        this.lastError = 'FEN inválida';
        return this.load(START_FEN);
      }
    }
    this.turn = parts[1] === 'b' ? BLACK : WHITE;
    const cast = parts[2] || '-';
    if (cast.includes('K')) this.castling |= 1;
    if (cast.includes('Q')) this.castling |= 2;
    if (cast.includes('k')) this.castling |= 4;
    if (cast.includes('q')) this.castling |= 8;
    const ep = parts[3] && parts[3] !== '-' ? nameToSq(parts[3]) : -1;
    this.ep = ep;
    this.halfmove = Number(parts[4] || 0) || 0;
    this.fullmove = Number(parts[5] || 1) || 1;
    this.computeHash();
    this.positionHashes.push(this.hash1 >>> 0, this.hash2 >>> 0);
    return this;
  }

  fen() {
    let out = '';
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const piece = this.board[rank * 16 + file];
        if (!piece) {
          empty++;
          continue;
        }
        if (empty) {
          out += empty;
          empty = 0;
        }
        const letter = PIECE_LETTERS[Math.abs(piece)];
        out += piece > 0 ? letter : letter.toLowerCase();
      }
      if (empty) out += empty;
      if (rank) out += '/';
    }
    let cast = '';
    if (this.castling & 1) cast += 'K';
    if (this.castling & 2) cast += 'Q';
    if (this.castling & 4) cast += 'k';
    if (this.castling & 8) cast += 'q';
    return `${out} ${this.turn === WHITE ? 'w' : 'b'} ${cast || '-'} ${this.ep >= 0 ? sqToName(this.ep) : '-'} ${this.halfmove} ${this.fullmove}`;
  }

  computeHash() {
    let a = 0;
    let b = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const piece = this.board[sq];
      if (!piece) continue;
      const idx = zIndex(piece) + sq;
      a ^= Z_PIECE_A[idx];
      b ^= Z_PIECE_B[idx];
    }
    a ^= Z_CASTLE_A[this.castling];
    b ^= Z_CASTLE_B[this.castling];
    if (this.ep >= 0) {
      a ^= Z_EP_A[this.ep & 7];
      b ^= Z_EP_B[this.ep & 7];
    }
    if (this.turn === BLACK) {
      a ^= Z_TURN_A;
      b ^= Z_TURN_B;
    }
    this.hash1 = a >>> 0;
    this.hash2 = b >>> 0;
  }

  get positionKey() {
    return this.hash1.toString(36) + ':' + this.hash2.toString(36);
  }

  pieceAt(sq) {
    return typeof sq === 'string' ? this.board[nameToSq(sq)] : this.board[sq];
  }

  inCheck(side = this.turn) {
    const kingSq = this.kings[side === WHITE ? 0 : 1];
    if (kingSq < 0) return false;
    return this.isSquareAttacked(kingSq, -side);
  }

  isSquareAttacked(sq, by) {
    const b = this.board;
    // pawns
    if (by === WHITE) {
      for (const d of [-15, -17]) {
        const from = sq + d;
        if (onBoard(from) && b[from] === PAWN) return true;
      }
    } else {
      for (const d of [15, 17]) {
        const from = sq + d;
        if (onBoard(from) && b[from] === -PAWN) return true;
      }
    }
    // knights
    const knight = by * KNIGHT;
    for (let i = 0; i < 8; i++) {
      const from = sq + KNIGHT_OFFSETS[i];
      if (onBoard(from) && b[from] === knight) return true;
    }
    // king
    const king = by * KING;
    for (let i = 0; i < 8; i++) {
      const from = sq + KING_OFFSETS[i];
      if (onBoard(from) && b[from] === king) return true;
    }
    // bishops / queens
    const bishop = by * BISHOP;
    const queen = by * QUEEN;
    for (const d of BISHOP_DIRS) {
      let to = sq + d;
      while (onBoard(to)) {
        const p = b[to];
        if (p) {
          if (p === bishop || p === queen) return true;
          break;
        }
        to += d;
      }
    }
    // rooks / queens
    const rook = by * ROOK;
    for (const d of ROOK_DIRS) {
      let to = sq + d;
      while (onBoard(to)) {
        const p = b[to];
        if (p) {
          if (p === rook || p === queen) return true;
          break;
        }
        to += d;
      }
    }
    return false;
  }

  /* ---------------------------- move generation ---------------------------- */

  generateMoves(capturesOnly = false) {
    const pseudo = this.generatePseudoMoves(capturesOnly);
    const legal = [];
    for (let i = 0; i < pseudo.length; i++) {
      const m = pseudo[i];
      const us = this.turn;
      this.makeMove(m);
      if (!this.isSquareAttacked(this.kings[us === WHITE ? 0 : 1], -us)) legal.push(m);
      this.unmakeMove();
    }
    return legal;
  }

  generatePseudoMoves(capturesOnly = false) {
    const b = this.board;
    const us = this.turn;
    const them = -us;
    const moves = [];
    for (let from = 0; from < 128; from++) {
      if (from & 0x88) continue;
      const piece = b[from];
      if (!piece || Math.sign(piece) !== us) continue;
      const type = Math.abs(piece);

      if (type === PAWN) {
        const dir = us === WHITE ? 16 : -16;
        const startRank = us === WHITE ? 1 : 6;
        const promoRank = us === WHITE ? 7 : 0;
        const one = from + dir;
        if (onBoard(one) && !b[one]) {
          if ((one >> 4) === promoRank) {
            for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT]) {
              moves.push(makeMoveInt(from, one, promo, FLAG_PROMOTION));
            }
          } else if (!capturesOnly) {
            moves.push(makeMoveInt(from, one));
            const two = from + dir * 2;
            if ((from >> 4) === startRank && !b[two]) {
              moves.push(makeMoveInt(from, two, 0, FLAG_DOUBLE));
            }
          }
        }
        for (const d of [dir - 1, dir + 1]) {
          const to = from + d;
          if (!onBoard(to)) continue;
          const target = b[to];
          if (target && Math.sign(target) === them) {
            if ((to >> 4) === promoRank) {
              for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT]) {
                moves.push(makeMoveInt(from, to, promo, FLAG_PROMOTION | FLAG_CAPTURE));
              }
            } else {
              moves.push(makeMoveInt(from, to, 0, FLAG_CAPTURE));
            }
          } else if (to === this.ep) {
            const capturedSq = to - dir;
            if (b[capturedSq] === -us * PAWN) {
              moves.push(makeMoveInt(from, to, 0, FLAG_CAPTURE | FLAG_EP));
            }
          }
        }
        continue;
      }

      if (type === KNIGHT || type === KING) {
        const offsets = type === KNIGHT ? KNIGHT_OFFSETS : KING_OFFSETS;
        for (const d of offsets) {
          const to = from + d;
          if (!onBoard(to)) continue;
          const target = b[to];
          if (target && Math.sign(target) === us) continue;
          if (capturesOnly && !target) continue;
          moves.push(makeMoveInt(from, to, 0, target ? FLAG_CAPTURE : 0));
        }
        if (type === KING && !capturesOnly) {
          const homeRank = us === WHITE ? 0 : 7;
          if ((from >> 4) === homeRank && (from & 7) === 4) {
            const kRight = us === WHITE ? 1 : 4;
            const qRight = us === WHITE ? 2 : 8;
            if (this.castling & kRight) {
              const f = from + 1;
              const g = from + 2;
              const rookSq = from + 3;
              if (!b[f] && !b[g] && b[rookSq] === us * ROOK &&
                  !this.isSquareAttacked(from, them) &&
                  !this.isSquareAttacked(f, them) &&
                  !this.isSquareAttacked(g, them)) {
                moves.push(makeMoveInt(from, g, 0, FLAG_KCASTLE));
              }
            }
            if (this.castling & qRight) {
              const dSq = from - 1;
              const cSq = from - 2;
              const bSq = from - 3;
              const rookSq = from - 4;
              if (!b[dSq] && !b[cSq] && !b[bSq] && b[rookSq] === us * ROOK &&
                  !this.isSquareAttacked(from, them) &&
                  !this.isSquareAttacked(dSq, them) &&
                  !this.isSquareAttacked(cSq, them)) {
                moves.push(makeMoveInt(from, cSq, 0, FLAG_QCASTLE));
              }
            }
          }
        }
        continue;
      }

      const dirs = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS];
      for (const d of dirs) {
        let to = from + d;
        while (onBoard(to)) {
          const target = b[to];
          if (!target) {
            if (!capturesOnly) moves.push(makeMoveInt(from, to));
          } else {
            if (Math.sign(target) === them) moves.push(makeMoveInt(from, to, 0, FLAG_CAPTURE));
            break;
          }
          to += d;
        }
      }
    }
    return moves;
  }

  /* ------------------------------ make / unmake ---------------------------- */

  makeMove(move) {
    const from = moveFrom(move);
    const to = moveTo(move);
    const flags = moveFlags(move);
    const promo = movePromotion(move);
    const us = this.turn;
    const them = -us;
    const b = this.board;
    const piece = b[from];

    const entry = {
      move,
      captured: 0,
      capturedSq: -1,
      castling: this.castling,
      ep: this.ep,
      halfmove: this.halfmove,
      fullmove: this.fullmove,
      kings: [this.kings[0], this.kings[1]],
      hash1: this.hash1,
      hash2: this.hash2,
    };
    this.history.push(entry);

    let a = this.hash1;
    let bb = this.hash2;
    const xorPiece = (p, sq) => {
      const idx = zIndex(p) + sq;
      a ^= Z_PIECE_A[idx];
      bb ^= Z_PIECE_B[idx];
    };

    // remove moving piece from its origin
    xorPiece(piece, from);
    b[from] = 0;

    // captured piece (normal or en passant)
    let capturedSq = to;
    if (flags & FLAG_EP) capturedSq = to - 16 * us;
    const captured = b[capturedSq];
    if (captured) {
      entry.captured = captured;
      entry.capturedSq = capturedSq;
      xorPiece(captured, capturedSq);
      b[capturedSq] = 0;
    }

    // place moved piece (promotion aware)
    const placed = promo ? promo * us : piece;
    b[to] = placed;
    xorPiece(placed, to);

    // move rook when castling
    if (flags & FLAG_KCASTLE) {
      const rookFrom = to + 1;
      const rookTo = to - 1;
      b[rookTo] = b[rookFrom];
      b[rookFrom] = 0;
      xorPiece(us * ROOK, rookFrom);
      xorPiece(us * ROOK, rookTo);
    } else if (flags & FLAG_QCASTLE) {
      const rookFrom = to - 2;
      const rookTo = to + 1;
      b[rookTo] = b[rookFrom];
      b[rookFrom] = 0;
      xorPiece(us * ROOK, rookFrom);
      xorPiece(us * ROOK, rookTo);
    }

    // king square tracking
    if (Math.abs(piece) === KING) {
      this.kings[us === WHITE ? 0 : 1] = to;
    }

    // castling rights
    let newCastling = this.castling;
    if (Math.abs(piece) === KING) {
      newCastling &= us === WHITE ? ~(1 | 2) : ~(4 | 8);
    }
    const clearRookRight = (sq) => {
      if (sq === 0) newCastling &= ~2;
      else if (sq === 7) newCastling &= ~1;
      else if (sq === 112) newCastling &= ~8;
      else if (sq === 119) newCastling &= ~4;
    };
    if (Math.abs(piece) === ROOK) clearRookRight(from);
    if (captured && Math.abs(captured) === ROOK) clearRookRight(capturedSq);

    // en passant target, only when a capture is actually possible
    let newEp = -1;
    if (flags & FLAG_DOUBLE) {
      const target = from + 16 * us;
      const enemyPawn = -us * PAWN;
      const left = target + 15 * us;
      const right = target + 17 * us;
      if ((onBoard(left) && b[left] === enemyPawn) || (onBoard(right) && b[right] === enemyPawn)) {
        newEp = target;
      }
    }

    // hash deltas for state
    a ^= Z_CASTLE_A[this.castling] ^ Z_CASTLE_A[newCastling];
    bb ^= Z_CASTLE_B[this.castling] ^ Z_CASTLE_B[newCastling];
    if (this.ep >= 0) {
      a ^= Z_EP_A[this.ep & 7];
      bb ^= Z_EP_B[this.ep & 7];
    }
    if (newEp >= 0) {
      a ^= Z_EP_A[newEp & 7];
      bb ^= Z_EP_B[newEp & 7];
    }
    a ^= Z_TURN_A;
    bb ^= Z_TURN_B;

    this.castling = newCastling;
    this.ep = newEp;
    this.halfmove = (Math.abs(piece) === PAWN || captured) ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.turn = them;
    this.hash1 = a >>> 0;
    this.hash2 = bb >>> 0;
    this.positionHashes.push(this.hash1, this.hash2);
  }

  unmakeMove() {
    const entry = this.history.pop();
    if (!entry) return null;
    const move = entry.move;
    const from = moveFrom(move);
    const to = moveTo(move);
    const flags = moveFlags(move);
    const promo = movePromotion(move);
    const us = -this.turn;
    const b = this.board;

    b[from] = promo ? us * PAWN : b[to];
    b[to] = 0;

    if (entry.captured) {
      b[entry.capturedSq] = entry.captured;
    }
    if (flags & FLAG_KCASTLE) {
      const rookFrom = to + 1;
      const rookTo = to - 1;
      b[rookFrom] = b[rookTo];
      b[rookTo] = 0;
    } else if (flags & FLAG_QCASTLE) {
      const rookFrom = to - 2;
      const rookTo = to + 1;
      b[rookFrom] = b[rookTo];
      b[rookTo] = 0;
    }

    this.turn = us;
    this.castling = entry.castling;
    this.ep = entry.ep;
    this.halfmove = entry.halfmove;
    this.fullmove = entry.fullmove;
    this.kings[0] = entry.kings[0];
    this.kings[1] = entry.kings[1];
    this.hash1 = entry.hash1;
    this.hash2 = entry.hash2;
    this.positionHashes.pop();
    this.positionHashes.pop();
    return move;
  }

  undo() {
    if (!this.history.length) return null;
    return this.unmakeMove();
  }

  /* ------------------------------- notation ------------------------------- */

  moveToSan(move) {
    const from = moveFrom(move);
    const to = moveTo(move);
    const flags = moveFlags(move);
    const promo = movePromotion(move);
    const piece = this.board[from];
    const type = Math.abs(piece);

    let san;
    if (flags & FLAG_KCASTLE) {
      san = 'O-O';
    } else if (flags & FLAG_QCASTLE) {
      san = 'O-O-O';
    } else if (type === PAWN) {
      san = '';
      if (flags & FLAG_CAPTURE) san += FILES[from & 7] + 'x';
      san += sqToName(to);
      if (promo) san += '=' + PIECE_LETTERS[promo];
    } else {
      san = PIECE_LETTERS[type];
      const legal = this.generateMoves(false);
      const rivals = [];
      for (const m of legal) {
        if (m === move) continue;
        if (moveTo(m) !== to) continue;
        if (Math.abs(this.board[moveFrom(m)]) !== type) continue;
        if (Math.sign(this.board[moveFrom(m)]) !== Math.sign(piece)) continue;
        rivals.push(m);
      }
      if (rivals.length) {
        const sameFile = rivals.some((m) => (moveFrom(m) & 7) === (from & 7));
        const sameRank = rivals.some((m) => (moveFrom(m) >> 4) === (from >> 4));
        if (!sameFile) san += FILES[from & 7];
        else if (!sameRank) san += String((from >> 4) + 1);
        else san += sqToName(from);
      }
      if (flags & FLAG_CAPTURE) san += 'x';
      san += sqToName(to);
    }

    this.makeMove(move);
    const check = this.isSquareAttacked(this.kings[this.turn === WHITE ? 0 : 1], -this.turn);
    const hasMoves = this.generateMoves(false).length > 0;
    if (check && !hasMoves) san += '#';
    else if (check) san += '+';
    this.unmakeMove();
    return san;
  }

  findMove(from, to, promo = 0) {
    if (typeof from === 'string') from = nameToSq(from);
    if (typeof to === 'string') to = nameToSq(to);
    const moves = this.generateMoves(false);
    return moves.find((m) => moveFrom(m) === from && moveTo(m) === to &&
      (promo ? movePromotion(m) === promo : true)) ?? null;
  }

  findMoveByUci(uci) {
    const parsed = typeof uci === 'string' ? uciToMove(uci) : uci;
    if (!parsed) return null;
    const moves = this.generateMoves(false);
    return moves.find((m) => {
      if (moveFrom(m) !== parsed.from || moveTo(m) !== parsed.to) return false;
      const p = movePromotion(m);
      return parsed.promo ? p === parsed.promo : p === 0;
    }) ?? null;
  }

  matchSan(input) {
    if (typeof input !== 'string') return null;
    const raw = input.trim();
    if (!raw) return null;
    const direct = this.findMoveByUci(raw);
    if (direct) return direct;
    const norm = (s) => s.replace(/[+#!?\s]/g, '').replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O').toLowerCase();
    const target = norm(raw.replace(/=([qrbn])/gi, '$1'));
    const moves = this.generateMoves(false);
    for (const m of moves) {
      const san = this.moveToSan(m);
      if (norm(san) === target) return m;
      if (norm(moveToUci(m)) === target) return m;
    }
    return null;
  }

  /* -------------------------------- state -------------------------------- */

  isRepetition(times = 2) {
    const keyA = this.hash1;
    const keyB = this.hash2;
    let count = 1; // current position
    for (let i = this.positionHashes.length - 4; i >= 0; i -= 2) {
      if (this.positionHashes[i] === keyA && this.positionHashes[i + 1] === keyB) {
        count++;
        if (count >= times) return true;
      }
    }
    return false;
  }

  isInsufficientMaterial() {
    let knights = 0;
    let bishops = 0;
    let bishopColors = new Set();
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const p = this.board[sq];
      if (!p) continue;
      const type = Math.abs(p);
      if (type === PAWN || type === ROOK || type === QUEEN) return false;
      if (type === KNIGHT) knights++;
      if (type === BISHOP) {
        bishops++;
        bishopColors.add(((sq >> 4) + (sq & 7)) & 1);
      }
    }
    if (knights + bishops <= 1) return true;
    if (knights === 0 && bishops === 2 && bishopColors.size === 1) return true;
    return false;
  }

  status() {
    const side = this.turn;
    const check = this.inCheck(side);
    const moves = this.generateMoves(false);
    if (!moves.length) {
      if (check) {
        return { over: true, check: true, checkmate: true, stalemate: false, draw: false, winner: -side, reason: 'checkmate', legalMoves: moves };
      }
      return { over: true, check: false, checkmate: false, stalemate: true, draw: true, winner: 0, reason: 'stalemate', legalMoves: moves };
    }
    if (this.halfmove >= 100) {
      return { over: true, check, checkmate: false, stalemate: false, draw: true, winner: 0, reason: 'fifty', legalMoves: moves };
    }
    if (this.isRepetition(3)) {
      return { over: true, check, checkmate: false, stalemate: false, draw: true, winner: 0, reason: 'repetition', legalMoves: moves };
    }
    if (this.isInsufficientMaterial()) {
      return { over: true, check, checkmate: false, stalemate: false, draw: true, winner: 0, reason: 'material', legalMoves: moves };
    }
    return { over: false, check, checkmate: false, stalemate: false, draw: false, winner: 0, reason: null, legalMoves: moves };
  }

  /* ---------------------------------- misc --------------------------------- */

  perft(depth) {
    if (depth === 0) return 1;
    const moves = this.generateMoves(false);
    if (depth === 1) return moves.length;
    let nodes = 0;
    for (const m of moves) {
      this.makeMove(m);
      nodes += this.perft(depth - 1);
      this.unmakeMove();
    }
    return nodes;
  }

  clone() {
    const c = new Chess(this.fen());
    return c;
  }
}

export const pieceLetter = (piece) => {
  if (!piece) return null;
  const letter = PIECE_LETTERS[Math.abs(piece)];
  return piece > 0 ? letter : letter.toLowerCase();
};

export const pieceColor = (piece) => (piece > 0 ? WHITE : piece < 0 ? BLACK : 0);
