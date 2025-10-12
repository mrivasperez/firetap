# Firetap Workspace

**Real-time collaborative editing with TipTap, Yjs, Firebase, and WebRTC**

This is a monorepo workspace containing the Firetap library, a demo client application, and Firebase Cloud Functions. The workspace is pre-configured with Firebase Emulators for local development and testing.

## Project Structure

```
firetap/
├── lib/              # Firetap NPM package (the core library)
├── client/           # Demo React app with TipTap collaborative editor
├── functions/        # Firebase Cloud Functions
├── firebase.json     # Firebase configuration
├── .firebaserc       # Firebase project settings (demo-firetap)
└── package.json      # Workspace root package
```

## Quick Start

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Firebase CLI (`npm install -g firebase-tools`)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/mrivasperez/firetap.git
   cd firetap
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start Firebase Emulators**
   ```bash
   npm run emulators
   ```
   
   The emulators will start with the following ports:
   - **Realtime Database**: `localhost:9000`
   - **Authentication**: `localhost:9099`
   - **Firestore**: `localhost:8080`
   - **Functions**: `localhost:5001`
   - **Hosting**: `localhost:5000`
   - **Emulator UI**: `http://localhost:4000`

4. **Start the demo client** (in a new terminal)
   ```bash
   npm run dev:client
   ```

5. **Open multiple browser windows**
   
   Navigate to the Vite dev server URL (usually `http://localhost:5173`) in multiple windows or tabs to see real-time collaboration in action!

## Packages

### `lib/` - Firetap Library

The core NPM package that provides the Firebase + WebRTC adapter for Yjs collaboration.

**Key Features:**
- WebRTC mesh networking for peer-to-peer sync
- Firebase Realtime Database for persistence
- Native gzip compression (no dependencies)
- 99%+ reduction in Firebase bandwidth costs
- Built for TipTap and Yjs

[Read the full documentation →](./lib/README.md)

**Build the library:**
```bash
npm run build:lib
```

### `client/` - Demo Application

A React + Vite application demonstrating Firetap with TipTap collaborative editor.

**Features:**
- Real-time collaborative text editing
- User presence and cursors
- Color-coded collaborators
- Firebase Emulator integration

**Run the client:**
```bash
npm run dev:client
```

### `functions/` - Cloud Functions

Firebase Cloud Functions for server-side operations (lots of awesome things one can do with that).

## Development Scripts

| Command | Description |
|---------|-------------|
| `npm run emulators` | Start Firebase Emulators Suite |
| `npm run dev:client` | Start Vite dev server for client app |
| `npm run build:lib` | Build the Firetap library |
| `npm run build:all` | Build both library and client |

## Firebase Emulators

This workspace is configured with Firebase Emulators for local development. No cloud deployment or billing required for testing!

### Emulator Configuration

The workspace uses the `demo-firetap` project (configured in `.firebaserc`) which works seamlessly with Firebase Emulators without requiring a real Firebase project.

**Emulator Ports:**
```json
{
  "auth": 9099,
  "functions": 5001,
  "firestore": 8080,
  "database": 9000,
  "hosting": 5000,
  "ui": 4000
}
```

### Working with Emulators

**Start emulators:**
```bash
npm run emulators
```

**View Emulator UI:**
Open `http://localhost:4000` to access the Firebase Emulator UI where you can:
- View and edit Realtime Database data
- Inspect Authentication users
- Monitor Functions logs
- Clear all emulator data

**Client connects automatically:**
The demo client is pre-configured to use the emulators in development mode (see `client/src/firebase.ts`).

## Configuration

### Firebase Setup

The workspace includes Firebase configuration files:
- `firebase.json` - Emulator and hosting configuration
- `.firebaserc` - Project aliases (demo-firetap)
- `database.rules.json` - Realtime Database security rules
- `firestore.rules` - Firestore security rules
- `storage.rules` - Storage security rules

### Security Rules

The included security rules allow read/write access in emulator mode for easy testing. **Update these before deploying to production!**

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser Clients                          │
│  ┌──────────┐      ┌──────────┐      ┌──────────┐          │
│  │ Client A │◄────►│ Client B │◄────►│ Client C │          │
│  └────┬─────┘      └────┬─────┘      └────┬─────┘          │
│       │  WebRTC Mesh    │                  │                │
│       │  (Real-time)    │                  │                │
└───────┼─────────────────┼──────────────────┼────────────────┘
        │                 │                  │
        │    Firebase     │                  │
        └────────┬────────┘                  │
                 ▼                           │
┌─────────────────────────────────────────────────────────────┐
│          Firebase Realtime Database (Emulator)               │
│  ┌─────────────────────────────────────────────────┐       │
│  │  • Document snapshots (compressed)              │       │
│  │  • WebRTC signaling                             │       │
│  │  • Peer presence                                │       │
│  └─────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

**How it works:**
1. Clients load initial document state from Firebase
2. WebRTC connections established between peers
3. Real-time edits sync via WebRTC mesh (bypassing Firebase)
4. Periodic snapshots saved to Firebase for persistence
5. New clients load latest snapshot and join the mesh

## Performance & Cost Optimization

Firetap is designed to minimize Firebase Realtime Database costs:

- **WebRTC mesh networking**: Active collaboration happens peer-to-peer
- **Native compression**: Gzip compression reduces payload sizes by 60-80%
- **Smart persistence**: Only periodic snapshots, not every keystroke
- **Efficient signaling**: Minimal Firebase usage for WebRTC handshake

**Real-world savings**: ~99.8% reduction in Firebase bandwidth costs compared to Firebase-only sync.

[Read more about performance optimization →](./lib/README.md#-firebase-cost-optimization-)

## Testing Collaboration

1. Start the emulators: `npm run emulators`
2. Start the client: `npm run dev:client`
3. Open `http://localhost:5173` in multiple browser windows
4. Start typing in any window - see changes appear in all windows instantly!
5. Check the Emulator UI at `http://localhost:4000` to inspect the data

## License

MIT License - see [LICENSE](./LICENSE) file for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Links

- [Firetap Library Documentation](./lib/README.md)
- [GitHub Repository](https://github.com/mrivasperez/firetap)
- [Issue Tracker](https://github.com/mrivasperez/firetap/issues)
- [Firebase Emulators](https://firebase.google.com/docs/emulator-suite)
- [Yjs Documentation](https://docs.yjs.dev/)
- [TipTap Documentation](https://tiptap.dev/)

---

Built with ❤️ by [Miguel Rivas Perez](https://github.com/mrivasperez)