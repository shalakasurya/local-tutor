// Environment bootstrap — MUST be the first import in main/index.ts so that
// modules reading process.env at import time (instructor model/effort, notes
// model) see the loaded values.
import { config } from 'dotenv'
import { app } from 'electron'
import { join } from 'path'

// Keep one data directory across dev and packaged builds (packaged apps would
// otherwise derive it from productName and orphan the dev data).
app.setPath('userData', join(app.getPath('appData'), 'local-tutor'))

// Dev: .env in the project cwd. Packaged: .env in the user data directory
// (~/Library/Application Support/local-tutor/.env). Both are optional; the
// Anthropic SDK can also resolve credentials from the environment.
config()
config({ path: join(app.getPath('userData'), '.env') })
