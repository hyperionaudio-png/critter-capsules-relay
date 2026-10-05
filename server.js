// =====================================================================
// Critter Capsules - multiplayer relay server
// =====================================================================
//
// A tiny, dependency-free WebSocket server (just Node.js 18+).
//
//  - Players create a room and get a 4-letter code; friends join with it.
//  - The host picks a game and starts it. The server hands everyone the
//    same random seed, so dice rolls etc. are identical on every phone.
//  - Moves are relayed to EVERYONE in the room (including the sender)
//    with a sequence number. Every client applies moves in that order,
//    so all boards stay in sync. The game rules live in the Godot client.
//
// Run locally:   node server.js            (listens on PORT or 8080)
// Health check:  GET /  ->  "ok"
//
// Protocol (JSON text frames). Client -> server:
//   {t:"hello", v, name}                 first message after connecting
//   {t:"create", game, name?}            make a room (you become host)
//   {t:"join", code, name?}              join a room by code
//   {t:"set_game", game}                 host: choose game in the lobby
//   {t:"start"}                          host: start / restart the game
//   {t:"lobby"}                          host: everyone back to the lobby
//   {t:"move", data}                     relay a game move
//   {t:"leave"}                          leave the room
//   {t:"ping"}                           keep-alive
// Server -> client:
//   {t:"welcome", id}
//   {t:"room", code, host, game, started, players:[{id,name}]}
//   {t:"start", game, seed, players}
//   {t:"move", from, seq, data}
//   {t:"left", id, name}
//   {t:"error", code, msg}
//   {t:"pong"}
// =====================================================================

"use strict";

const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8080;
const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_MESSAGES_PER_SECOND = 40;
const MAX_ROOM_PLAYERS = 4;
const HEARTBEAT_MS = 25000;
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I / O (look like 1 / 0)

// Player limits per game. Keep in sync with Online.GAMES in Godot.
const GAMES = {
  clash: { min: 2, max: 2 },
  connect4: { min: 2, max: 2 },
  checkers: { min: 2, max: 2 },
  snakes: { min: 2, max: 4 },
};

const rooms = new Map(); // code -> room
let nextClientId = 1;

// ------------------------------------------------------------------ rooms

function makeCode() {
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) {
      code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    }
    if (!rooms.has(code)) return code;
  }
}

function roomInfo(room) {
  return {
    t: "room",
    code: room.code,
    host: room.host,
    game: room.game,
    started: room.started,
    players: room.players.map((c) => ({ id: c.id, name: c.name })),
  };
}

function broadcast(room, message) {
  const text = JSON.stringify(message);
  for (const client of room.players) client.sendText(text);
}

function leaveRoom(client) {
  const room = client.room;
  if (!room) return;
  client.room = null;
  room.players = room.players.filter((c) => c !== client);

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.host === client.id) room.host = room.players[0].id;

  // A game can't continue with someone missing: back to the lobby.
  const wasStarted = room.started;
  room.started = false;
  broadcast(room, { t: "left", id: client.id, name: client.name, during_game: wasStarted });
  broadcast(room, roomInfo(room));
}

// ------------------------------------------------------------------ messages

function cleanName(name) {
  const text = String(name || "").replace(/[^\p{L}\p{N} _\-.!?]/gu, "").trim();
  return (text || "Player").slice(0, 16);
}

function handleMessage(client, msg) {
  const room = client.room;
  const isHost = room && room.host === client.id;

  switch (msg.t) {
    case "hello":
      if (msg.v !== PROTOCOL_VERSION) {
        return client.error("version", "Please update the game to play online.");
      }
      client.name = cleanName(msg.name);
      client.hello = true;
      return client.send({ t: "welcome", id: client.id });

    case "ping":
      return client.send({ t: "pong" });
  }

  if (!client.hello) return client.error("hello", "Say hello first.");

  switch (msg.t) {
    case "create": {
      if (!GAMES[msg.game]) return client.error("game", "Unknown game.");
      if (msg.name) client.name = cleanName(msg.name);
      leaveRoom(client);
      const code = makeCode();
      const newRoom = { code, host: client.id, game: msg.game, started: false, players: [client], seq: 0 };
      rooms.set(code, newRoom);
      client.room = newRoom;
      return client.send(roomInfo(newRoom));
    }

    case "join": {
      const code = String(msg.code || "").toUpperCase().trim();
      const target = rooms.get(code);
      if (!target) return client.error("no_room", "No room with that code.");
      if (target.started) return client.error("started", "That game has already started.");
      if (target.players.length >= MAX_ROOM_PLAYERS) return client.error("full", "That room is full.");
      if (target === room) return client.send(roomInfo(room));
      if (msg.name) client.name = cleanName(msg.name);
      leaveRoom(client);
      target.players.push(client);
      client.room = target;
      return broadcast(target, roomInfo(target));
    }

    case "set_game":
      if (!isHost) return client.error("host", "Only the host can do that.");
      if (!GAMES[msg.game]) return client.error("game", "Unknown game.");
      if (room.started) return client.error("started", "Finish the current game first.");
      room.game = msg.game;
      return broadcast(room, roomInfo(room));

    case "start": {
      if (!isHost) return client.error("host", "Only the host can start.");
      const rules = GAMES[room.game];
      const count = room.players.length;
      if (count < rules.min) return client.error("players", "Waiting for more players.");
      if (count > rules.max) return client.error("players", `This game is for up to ${rules.max} players.`);
      room.started = true;
      room.seq = 0;
      broadcast(room, roomInfo(room));
      return broadcast(room, {
        t: "start",
        game: room.game,
        seed: crypto.randomInt(1, 2147483647),
        players: room.players.map((c) => ({ id: c.id, name: c.name })),
      });
    }

    case "lobby":
      if (!isHost) return client.error("host", "Only the host can do that.");
      room.started = false;
      return broadcast(room, roomInfo(room));

    case "move":
      if (!room || !room.started) return; // stale move after the game ended
      room.seq += 1;
      return broadcast(room, { t: "move", from: client.id, seq: room.seq, data: msg.data });

    case "leave":
      leaveRoom(client);
      return client.send({ t: "room", code: "", host: 0, game: "", started: false, players: [] });

    default:
      return client.error("unknown", "Unknown message.");
  }
}

// ------------------------------------------------------------------ WebSocket (RFC 6455)

class Client {
  constructor(socket) {
    this.socket = socket;
    this.id = nextClientId++;
    this.name = "Player";
    this.hello = false;
    this.room = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.alive = true;
    this.rateWindow = Date.now();
    this.rateCount = 0;
    this.closed = false;
  }

  send(message) {
    this.sendText(JSON.stringify(message));
  }

  error(code, msg) {
    this.send({ t: "error", code, msg });
  }

  sendText(text) {
    this.sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  sendFrame(opcode, payload) {
    if (this.closed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  close() {
    if (this.closed) return;
    this.sendFrame(0x8, Buffer.alloc(0));
    this.closed = true;
    this.socket.end();
    leaveRoom(this);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_MESSAGE_BYTES * 4) return this.close();

    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) return this.close();
      if (!masked) return this.close(); // clients must mask
      if (this.buffer.length < offset + 4 + length) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(offset + 4 + length);

      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) { this.sendFrame(0xa, payload); continue; } // ping -> pong
      if (opcode === 0xa) { this.alive = true; continue; }            // pong

      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        this.onText(text);
      }
    }
  }

  onText(text) {
    this.alive = true;
    const now = Date.now();
    if (now - this.rateWindow > 1000) {
      this.rateWindow = now;
      this.rateCount = 0;
    }
    if (++this.rateCount > MAX_MESSAGES_PER_SECOND) return;

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.error("json", "Bad message.");
    }
    if (!msg || typeof msg.t !== "string") return this.error("json", "Bad message.");
    handleMessage(this, msg);
  }
}

const clients = new Set();

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`ok - ${rooms.size} rooms, ${clients.size} players\n`);
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key || (req.headers.upgrade || "").toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const client = new Client(socket);
  clients.add(client);
  socket.on("data", (chunk) => client.onData(chunk));
  const drop = () => {
    clients.delete(client);
    client.closed = true;
    leaveRoom(client);
  };
  socket.on("close", drop);
  socket.on("error", drop);
});

// Drop connections that stopped answering (phone locked, lost signal...).
setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.socket.destroy();
      continue;
    }
    client.alive = false;
    client.sendFrame(0x9, Buffer.alloc(0));
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => console.log(`Critter Capsules relay listening on :${PORT}`));
