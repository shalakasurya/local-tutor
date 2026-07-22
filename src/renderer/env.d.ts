/// <reference types="vite/client" />

import type { TutorBridge } from '../shared/types'

declare global {
  interface Window {
    tutor: TutorBridge
  }
}

export {}
