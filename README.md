# IPL Auction Game 🏏

Play a live IPL auction with your friends online — everyone on their own phone, real-time bidding, no setup needed beyond a free hosting account.

## How it works

- One person **creates a room** and shares the code on WhatsApp
- Friends **join** with the code and pick their franchise
- The **host** starts the auction when everyone's ready
- Players are auctioned one by one with a 10-second countdown
- Every bid, purse change, and sold/unsold result is **live** for everyone instantly (Socket.io)
- At the end, everyone sees the final squad rankings

---

## Deploy to Render (free, ~5 minutes)

### Step 1 — Push to GitHub

1. Create a new repo on [github.com](https://github.com) (can be private)
2. Upload the contents of this folder (or push via git):
   ```bash
   git init
   git add .
   git commit -m "IPL Auction Game"
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

### Step 2 — Deploy on Render

1. Go to [render.com](https://render.com) → Sign up free (GitHub login works)
2. Click **New → Web Service**
3. Connect your GitHub repo
4. Fill in:
   - **Name**: ipl-auction (or anything)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Click **Create Web Service**
6. Wait ~2 minutes for it to build and deploy
7. Render gives you a URL like `https://ipl-auction.onrender.com`

**Share that URL with your friends — done!**

> ⚠️ On the free Render tier, the server sleeps after 15 minutes of inactivity. The first person to open it after a sleep may wait ~30 seconds for it to wake up. This is normal.

---

## Local development (test on your own laptop)

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser. To test multiplayer locally, open multiple browser tabs — each tab acts as a different player.

---

## How to play

1. **Host**: Enter your name → Create Room → share the room code on WhatsApp
2. **Friends**: Enter name + room code → Join Room → pick a franchise
3. **Host**: Once everyone's joined and picked a team → click **Begin Auction**
4. **Bidding**: Each player bids for their own team using the bid button (only your team's button is active for you)
5. **Timer**: 10 seconds per player. Each bid resets the clock. When it hits zero, player is sold or unsold
6. **End**: After all players are auctioned, see the final squad rankings and highlights

---

## Project structure

```
ipl-auction-app/
├── server/
│   ├── index.js        ← Express + Socket.io server (room management, auction engine, timer)
│   └── gameLogic.js    ← Pure game logic (bid validation, scoring, team setup)
├── shared/
│   └── gameData.js     ← Teams, 300 players, constants (used by both server and client)
├── public/
│   └── index.html      ← Full frontend (HTML + CSS + JS, wired to socket.io)
├── package.json
└── README.md
```

## Tech stack

- **Backend**: Node.js + Express + Socket.io
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **Realtime**: WebSockets via Socket.io
- **Hosting**: Any Node-capable host (Render, Railway, Fly.io, etc.)
