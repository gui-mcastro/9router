import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Wrapped /v1 routes record usage. Point HOME at a throwaway dir so no test can
// ever write to the real ~/.9router database (DATA_DIR defaults to ~/.9router).
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "9router-test-home-"));
