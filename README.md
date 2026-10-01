# Hello Neighbor – Alpha 1 (Fan Recreation)

A browser-playable, fan-made recreation of the original **Hello Neighbor Alpha 1**
experience, built from scratch with [Three.js](https://threejs.org/) and [Vite](https://vite.dev/).

You live across the street from a man who clearly has something to hide. Sneak into his
house, dodge him as he patrols, and find out what he's hiding, without getting caught.

**Every visit is a different house.** The layout, rooms, furniture, locked doors and where
things are hidden are all generated fresh each time you play.

> **Disclaimer:** this is an unofficial, non-commercial fan tribute. It is not affiliated
> with or endorsed by tinyBuild or Dynamic Pixels. It contains no assets from the original
> game. Every model, texture, and sound is generated procedurally in the browser.

---

## ▶️ Play it

### Option 1: GitHub Codespaces (no install)

1. On GitHub, click **Code → Codespaces → Create codespace on this branch**.
2. Wait for the container to build. It runs `npm install` and then starts the game
   server automatically (`npm run dev` on port **5173**).
3. A browser tab opens on the forwarded port. If it doesn't, open the **Ports** panel
   and click the 🌐 globe icon next to port `5173`.

> 💡 Use **"Open in Browser"** rather than VS Code's built-in *Simple Browser* preview.
> Embedded previews usually block mouse capture (pointer lock). The game still works
> there, but you'll have to drag to look around.

To start the server manually in any terminal: `npm run dev`.

### Option 2: Run locally

Requires [Node.js](https://nodejs.org/) 18 or newer.

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>.

### Sharing it with a Cloudflare tunnel

To let friends play what's running on your machine, build the fast production version and
tunnel it:

```bash
npm run share                                    # builds, then serves on port 4173
cloudflared tunnel --url http://localhost:4173   # in a second terminal
```

Send people the `https://….trycloudflare.com` link it prints. Tunnelling the dev server
(`npm run dev` + `--url http://localhost:5173`) also works, but it's slower to load and live
reload doesn't work through the tunnel. Any `*.trycloudflare.com` address is already
allowed. For other tunnel services, add their hostname, e.g.
`ALLOWED_HOSTS=.ngrok-free.app npm run share`.

### Option 3: GitHub Pages

The repo includes a workflow (`.github/workflows/pages.yml`) that builds the game and
publishes it to GitHub Pages on every push to `main`. Turn it on once under
**Settings → Pages → Build and deployment → Source: GitHub Actions**. The game will
then be live at `https://<user>.github.io/<repo>/`.

To build a static copy yourself, run `npm run build`. The output goes to `dist/` and can be
hosted on any static web server. It has to be served over HTTP, not opened as a `file://`.
GitHub Pages and other static hosts are single-player only: multiplayer needs the game
server (see below).

---

## 🎮 Controls

| Key | Action |
| --- | --- |
| **W A S D** | Move |
| **Mouse** (or arrow keys) | Look |
| **Shift** | Sprint (fast, but makes a little noise) |
| **C** / **Ctrl** | Crouch (harder to spot) |
| **Space** | Jump (onto counters, through windows) |
| **E** | Pick up / swap items, open doors and cupboards, use keys, hide, switch things on/off |
| **Left click** | Throw held item |
| **Q** / **Right click** | Drop held item |
| **F** | Flashlight |
| **Ctrl+W** | Won't close the game by accident: the browser asks "Leave site?" first, and in **Fullscreen** (tick it on the title screen or pause menu; Chrome/Edge) it does nothing at all |
| **M** | Capture the mouse again, if the browser refused (it often does right after Esc) |
| **Esc** / **P** | Pause (sensitivity, volume, restart). In multiplayer it opens the menu without pausing |
| **`** | Debug mode on / off (see below) |

Click the game to capture the mouse.

## 🏠 How to play

There are no objectives or hints. Exploring and figuring things out is the game. A few basics:

* The front door is locked. Find another way in. Windows break if you throw things at them,
  but he'll hear the glass.
* He patrols the house and yard. The **eye** at the top of the screen shows how suspicious
  he is. When it turns red he's chasing you, so break line of sight or get off his property.
  He never leaves his yard: once you're out of his front gate he can't follow you home.
* Walking and crouching are silent. Running makes a little noise if he's close by.
* Cupboards, fridges and chests open, and things are often tucked away inside.
* You can hide in wardrobes. If he watched you climb in, he'll yank the doors open and drag
  you out.
* He has a life: he naps, watches TV, reads, does the dishes, cooks, uses the toilet, mows the
  lawn, waters the flowers, checks the mail and more. Busy (or asleep) is your chance, but he
  still looks up, and he still hears loud noises.
* TVs and radios make a racket when switched on, and he'll come to turn them off.
* Throw an object at him to stun him for a couple of seconds.
* If he catches you, you wake up back in front of your own house. Doors you've opened stay
  open, but a key you were holding goes back to where you found it.

### Replaying a house

Each house has a number, shown in the pause menu and on the end screen. **Restart this
house** / **Replay this house** play the same one again. To share a house, add `?seed=` and
its number to the address, e.g. `http://localhost:5173/?seed=123456`. **New house** generates
a fresh one.

---

## 👥 Multiplayer

Up to 8 people can play in the same house. Press **Multiplayer** on the title screen:

1. Everyone opens the **same game address**: the Cloudflare link from `npm run share`
   (easiest for friends elsewhere), your Codespace's forwarded port, or
   `http://<your-computer's-IP>:5173` on the same Wi-Fi.
2. One person types their name and presses **Host a game**. They get a 4-letter room
   code (and a **Copy invite link** button).
3. Everyone else types the code and presses **Join**. If they had a different house
   loaded, the page reloads into the host's house and rejoins by itself.
4. The host picks a mode and presses **Start**. People can also join a game that's
   already running.

| Mode | How it plays |
| --- | --- |
| **Co-op** | Everyone sneaks in together and the AI neighbor hunts all of you. Keys, doors and boards are shared, so one of you can distract him while another grabs a key. Whoever he catches wakes up back on the street; the others keep going. Anyone reaching the basement wins it for everybody. |
| **Player neighbor** | One player **is** the neighbor (the host picks who, or Random). There's no AI. The kids win if anyone gets into the basement; the neighbor wins by catching kids 8 times per kid. |

Playing as the neighbor: you're a bit taller and slightly faster than the kids.
**Click** grabs a kid in front of you, **E** on a wardrobe searches it (anyone hiding inside
is caught), and you can open doors and throw things, but you can't pick up keys or the
crowbar. It's your house, so you can open **padlocked doors and the front door** (boarded-up
doors still stop you). You can't leave your property, though: the front gate is as far as
you go, and kids outside it can't be grabbed. A kid who hits you with a thrown object stuns
you for a couple of seconds.

**Chores (no camping):** like the AI neighbor, the neighbor player has chores. The HUD names
the current one (e.g. "doing the dishes (kitchen)") and a green marker shows the spot. Stand
there and it counts down (10-20 s). Then he gets a **15 s break** (free to roam and catch
kids, no skipping) before the next chore comes up. The kids see him doing it
and hear its usual sounds, but they never get told which chore he's on.

* **Hunting:** hearing or seeing a kid frees him to hunt for 25 s, topped up every time he
  hears or sees one again. Noises he makes himself never count: his footsteps and doors,
  or anything he threw, dropped or switched on (a radio left playing won't keep him hunting). When it runs out: "Nothing here... back to your chore."
* **After a catch:** straight back to chore mode with a new chore. The grab itself (the kid
  he's holding, whatever they dropped) doesn't count as hearing or seeing a kid, but another
  kid nearby still does, and he can catch while he heads to his chore.
* **Skipping chores:** he can ignore them, but once he's had enough time to walk there
  (plus 8 s) he's **skipping**: a red banner tells him, the kids see him through walls as a
  red silhouette, and he **can't catch anyone or search wardrobes**. Hearing or seeing kids
  doesn't get him out of it either; only going back to his chore does. So camping the
  basement door just gets him spotted, and catches nobody.

You hear the kids by the same rules as the AI neighbor: walking and crouching are silent,
but running, landing from a jump, and doors, cupboards and pried-off boards near you give
them away (only on your property). When you hear a kid, a see-through silhouette in their
colour marks where they were, visible through walls, with a timer ("Bea? · 12s"). It stays
until you hear that kid again (it moves) or catch them. Other noises (something thrown
landing, breaking glass, a TV left on) show a bright pulsing ring with a light beam for 8
seconds. Anything behind you or off-screen gets an arrow at the edge of your screen.

Notes:

* The host's browser runs the game for everyone, so the host should have the fastest
  computer and a steady connection. If the host leaves, the game ends for everyone.
* **Esc** opens the menu but doesn't pause the game for anyone else.
* Debug mode only works for the host of a co-op game.
* On **Codespaces**, forwarded ports are private by default. For friends to join, right-click
  port `5173` in the **Ports** panel and set **Port Visibility → Public**, then share that
  address.
* The server part is small: [`server/relay.js`](server/relay.js) runs inside the Vite dev
  and preview servers on `/mp` (same port as the game) and just passes messages between
  the host and everyone else.

---

## 🥽 VR mode (WebXR)

Got a headset? Open the game in your headset's browser (Quest Browser, Pico Browser, Wolvic)
or in a WebXR-capable desktop browser with PC VR connected, and press **Play in VR** on the
title screen. The button only appears when a headset is available.

WebXR needs a secure page, so use **HTTPS** or `localhost`. The easiest way from a Quest is
the Cloudflare tunnel above (`npm run share` + `cloudflared`), then open the
`https://….trycloudflare.com` link in the Quest browser.

| Control | What it does |
| --- | --- |
| **Left stick** | Walk where you're looking (click it to sprint) |
| **Both sticks clicked in** | Debug mode on / off (see [Debug mode in VR](#debug-mode-in-vr)) |
| **Right stick** | Snap turn 45° |
| **Trigger** | Use what that hand's laser points at: doors, cupboards, keys, wardrobes, TVs |
| **Grip** | Grab an item. **Let go mid-swing to throw it** (windows smash, the neighbor gets stunned) |
| **Left trigger** (pointing at nothing) | Flashlight, held in your left hand |
| **A / X** | Jump |
| **B** | Crouch toggle, or just **duck in real life** |

What's different in VR:

* **Physical play:** throw things for real, peek around corners, and duck behind counters.
  Crouching in your room makes you harder to see, because he checks where your
  head actually is.
* **Room-scale walking** is supported, but walls still stop you. You can't lean your head
  through a wall to peek.
* **Haptics:** a heartbeat in your hands while he's chasing you (faster when he's close), a
  jolt when he spots you, and a big one when he grabs you.
* **HUD in the headset:** prompts, messages, his awareness, and wardrobe slats while hiding.
* **Comfort:** the game never turns or rolls your view for you. Standalone headsets drop to
  the Low preset automatically, and PC VR is capped at Medium.

### VR in multiplayer (crossplay)

Headset and desktop players can share a game, in either mode, and anyone can be the
neighbor.

* **Joining in VR:** open the game in the headset's browser, press **Multiplayer**, host or
  join as usual, then press **Play in VR** in the lobby. You wait out on the street with the
  room code and the players in your headset. When the host starts, you're in. If the host is
  in VR, they pull a trigger to start (after picking the mode on the screen). If joining
  reloads the page into the host's house, the headset session ends: press **Play in VR**
  again once you're back in the lobby.
* **Switching mid-game:** taking the headset off opens the menu (the game keeps going for
  everyone else). **Resume in VR** puts you back in.
* **Playing the neighbor in VR:** reach for a kid and squeeze **Grip** (or pull the right
  **Trigger** at nothing) to grab them. Your laser turns yellow and the HUD says
  "GRAB ..." when one's in reach. **Trigger** on a wardrobe searches it. Your keys work on
  padlocked doors and the front door. You stand a little taller than in real life, like the
  neighbor. Your chore, the score and the "skipping chores" warning are in your headset HUD.
* **What everyone else sees:** a VR player's avatar turns with their head, and its arms follow
  their real hands, so you can see them reach, wave and wind up a throw. Their name tag says
  "VR". Thrown items fly at the speed of the real throw, for everyone.
* **Haptics online:** the heartbeat only kicks in when the AI neighbor is chasing *you*. Against
  a player neighbor it beats when he's close (and you're on his property).

---

## 🐞 Debug mode

Tick **Debug mode** on the title screen before pressing Play (it's remembered), or press
**`** (the backtick key, left of 1) at any point mid-game to switch it on or off. You get:

* **Chams / ESP** on the neighbor: he's highlighted through walls, with a box, distance and
  label, coloured by his mode (green idle, yellow suspicious, red attacking, purple stunned).
  When he's off-screen, an arrow at the edge of the screen points to him.
* His **vision cone**, the **route** he's walking, a **line of sight** to you (green when he
  can see you), and **noise rings** showing how far each sound carried (red = he heard it).
* A **debug panel** (top left) with his mode and raw AI state, the chore he's doing and how
  far through it he is, awareness, whether he sees you, when he last saw or heard you, where
  he is, whether he knows your hiding spot, plus your position, room and noise level, the
  locks left in the house, and FPS / draw calls.

| Key | Debug action |
| --- | --- |
| **`** | Turn debug mode on / off mid-game |
| **V** | See through the neighbor's eyes |
| **B** | Free camera: fly with WASD, Space/C up/down, Shift for speed. Passes through walls, and he ignores you completely |
| **T** | (in free camera) Teleport your body to the camera |
| **N** | Show the waypoint graph and chore spots |
| **L** | Show where the keys and crowbar are |
| **K** | Freeze / unfreeze the neighbor |
| **H** | Hide / show the debug panel |

### Debug mode in VR

**Click both thumbsticks in at the same time** to turn debug mode on or off. The info panel
floats above your **left wrist** (look at your hand to read it), and the neighbor, keys and
chore spots get floating labels instead of the on-screen ESP. The debug keys live on the right
controller while you **hold the left stick pressed in**:

| Hold left stick in + | Debug action (keyboard key) |
| --- | --- |
| **A** | See through the neighbor's eyes (V) |
| **B** | Free camera (B) |
| **Right trigger** | Teleport your body to the free camera (T) |
| **Right grip** | Freeze / unfreeze the neighbor (K) |
| **Right stick up** | Waypoint graph and chore spots (N) |
| **Right stick down** | Where the keys and crowbar are (L) |
| **Right stick left/right** | Hide / show the wrist panel (H) |
| **Right stick click** | Debug mode off (same as clicking both sticks) |

In the free camera, the left stick flies where you're looking, **A/X** go up, **B/Y** go down,
a quick click of the left stick toggles fast mode, and the right stick snap turns. In the
neighbor's view you ride along in his head and can still look around. The headset shows what
each button does while you hold the left stick in. The keyboard keys above work in VR too.

---

## ⚙️ Performance / Chromebooks

The game is tuned to run on school Chromebooks. Pick a preset under **Graphics** on the
title screen or in the pause menu. **Auto** chooses one from your device and remembers what
you pick.

| Preset | Meant for | What it does |
| --- | --- | --- |
| **Low (Chromebook)** | Chromebooks, low-end laptops | Simple lighting, no real-time shadows, 2 active room lights, renders at ≤85% resolution |
| **Medium** | Typical laptops | Simple lighting, 1024px shadows refreshed every 3rd frame, 3 room lights |
| **High** | Gaming PCs | Full PBR materials, anti-aliasing, 2048px shadows every frame, 4 room lights |

On every preset the game lowers its render resolution when the frame rate drops, then
raises it again when there's headroom. Turn on **Show FPS** to see the frame rate and
current resolution.

If it's still slow on a Chromebook:
* Play in a normal Chrome tab (not an embedded preview) and close other tabs.
* Keep the window smaller. Fewer pixels means more frames.
* Make sure the Chromebook is plugged in. Many throttle the GPU on battery.

---

## 🧩 Project structure

```
index.html            UI overlays (menu, HUD, pause, ending)
src/main.js           Game loop, input, interaction, items, catch/ending sequences
src/housegen.js       Procedural house layout: rooms, doors, windows, lock-and-key puzzle, nav graph
src/world.js          Builds the generated house (walls, stairs, basement, furniture, items) + street
src/builder.js        Merged static geometry, materials
src/rng.js            Seeded random numbers (so a house can be replayed)
src/neighbor.js       Neighbor model, vision/hearing, patrol/investigate/chase AI
src/chores.js         The neighbor's everyday chores (poses, props, sounds)
src/debug.js          Debug mode: chams/ESP, info panel, neighbor's-eye view, free camera
src/vr.js             WebXR: play-space rig, hands, lasers, throwing, haptics, in-headset HUD
src/nav.js            Waypoint graph + pathfinding for the neighbor
src/player.js         First-person controller (walk, sprint, crouch, jump)
src/physics.js        AABB collision (grid broadphase) for characters and sphere items
src/quality.js        Graphics presets, device detection, material swap, mesh baking
src/audio.js          Web Audio synthesized sound effects and chase music
src/textures.js       Procedural canvas textures
src/items.js          Throwable props and keys
src/mp.js             Multiplayer: lobby, host snapshots, applying them on the other players
src/net.js            WebSocket connection to the relay
src/avatar.js         Other players (kid models, name tags, smoothing, VR players' arms)
server/relay.js       Multiplayer relay (rooms + message passing), plugged into Vite on /mp
.devcontainer/        GitHub Codespaces configuration
```

Open the browser console and use `window.game` to poke at the running game while debugging.
