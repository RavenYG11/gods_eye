// Rujukan: docs/arsitektur.md §2
// Sampai Rama mencabut larangan deteksi, file ini HANYA re-export types.
// Sengaja TIDAK ada stub detect() yang pura-pura jalan — stub menyesatkan QA.
export type {
  Detection,
  DetectionFrame,
  DetectionPort,
  Detector,
} from "./types";
