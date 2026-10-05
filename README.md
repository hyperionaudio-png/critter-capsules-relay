# Critter Capsules relay server

A tiny WebSocket server that lets friends play the board games together
using 4-letter room codes. It has **no dependencies** – just Node.js 18+.

This repo is deployed on Render (see `render.yaml`). A copy of the same
code lives in the game project's `server/` folder.

## Try it on your computer

1. Install Node.js (https://nodejs.org).
2. In this folder run: `node server.js`
3. In Godot, run the game twice (Debug > Customize Run Instances > 2).
   `Scripts/Online.gd` points at `ws://127.0.0.1:8080` in the editor by default.

## Put it online for free (Render)

1. Go to https://render.com, sign in with GitHub, click **New > Web Service**
   and pick this repo.
2. Settings:
   - **Runtime:** Node
   - **Build Command:** *(leave empty)*
   - **Start Command:** `node server.js`
   - **Instance type:** Free
3. Create it. When it's live you'll get an address like
   `https://critter-capsules-relay.onrender.com`.
4. In Godot open `Scripts/Online.gd` and set
   `ONLINE_SERVER_URL` to the same address but starting with `wss://`, e.g.
   `wss://critter-capsules-relay.onrender.com`.

Note: Render's free servers go to sleep after ~15 minutes with nobody
connected. The first player to connect after that waits ~30-60 seconds
while it wakes up (the game shows "Connecting..."). A paid instance
(~$7/month) stays awake.

Any host that runs Node and supports WebSockets works the same way
(Fly.io, Railway, a VPS...). The server reads the port from `PORT`.

## Android export

Enable the **Internet** permission in your Android export preset
(Project > Export > Android > Permissions > Internet), or the game
can't reach the server.
