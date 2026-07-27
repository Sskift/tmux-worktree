import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const OUTPUT_ERROR = "Relay v2 host bootstrap output failed";

function outputError(): Error {
  return new Error(OUTPUT_ERROR);
}

function fsyncDirectory(path: string): void {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/**
 * Returns the synchronous restricted sink required by the shipping root admin
 * port. The secret is published through a same-directory 0600 temporary file
 * and atomic rename; failures never include the secret or output path.
 */
export function createRelayV2HostBootstrapOutputSink(
  outputPath: string,
): (secret: string) => void {
  if (outputPath.length === 0 || outputPath.includes("\0") || basename(outputPath).length === 0) {
    throw outputError();
  }

  return (secret: string): void => {
    const directory = dirname(outputPath);
    const temporary = join(
      directory,
      `.${basename(outputPath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
    );
    let fd = -1;
    try {
      fd = openSync(temporary, "wx", 0o600);
      chmodSync(temporary, 0o600);
      const contents = Buffer.from(`${secret}\n`, "utf8");
      let offset = 0;
      while (offset < contents.byteLength) {
        const written = writeSync(fd, contents, offset, contents.byteLength - offset, offset);
        if (written <= 0) throw outputError();
        offset += written;
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = -1;
      renameSync(temporary, outputPath);
      chmodSync(outputPath, 0o600);
      fsyncDirectory(directory);
    } catch {
      throw outputError();
    } finally {
      if (fd >= 0) {
        try { closeSync(fd); } catch {}
      }
      try { rmSync(temporary, { force: true }); } catch {}
    }
  };
}
