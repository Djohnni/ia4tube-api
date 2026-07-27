"use strict";

const fs = require("fs");

let archiverModulePromise = null;

async function createZipArchive(options = {}) {
  if (!archiverModulePromise) {
    archiverModulePromise = import("archiver");
  }

  const { ZipArchive } = await archiverModulePromise;
  if (typeof ZipArchive !== "function") {
    throw new Error("Archiver 8 ZipArchive indisponivel");
  }

  return new ZipArchive(options);
}

function directoryExists(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function sendZipError(res, status, message, error) {
  if (!res.headersSent) {
    res.removeHeader("Content-Type");
    res.removeHeader("Content-Disposition");
    if (typeof res.status === "function" && typeof res.json === "function") {
      res.status(status).json({ ok: false, error: message });
    } else {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }

  if (typeof res.destroy === "function" && !res.destroyed) {
    res.destroy(error);
  }
}

async function streamDirectoryZip({
  res,
  directory,
  filename,
  archiveFactory = createZipArchive
}) {
  if (!directoryExists(directory)) {
    sendZipError(res, 404, "Conteudo ZIP nao encontrado");
    return false;
  }

  let archive;
  try {
    archive = await archiveFactory({ zlib: { level: 9 } });
  } catch (error) {
    sendZipError(res, 500, "Falha ao iniciar ZIP", error);
    return false;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  return new Promise((resolve) => {
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const fail = (error) => {
      if (settled) return;
      sendZipError(res, 500, "Falha ao gerar ZIP", error);
      settle(false);
    };

    archive.once("error", fail);
    res.once("finish", () => settle(true));
    res.once("close", () => settle(false));

    try {
      archive.pipe(res);
      archive.directory(directory, false);
      Promise.resolve(archive.finalize()).catch(fail);
    } catch (error) {
      fail(error);
    }
  });
}

module.exports = {
  createZipArchive,
  directoryExists,
  streamDirectoryZip
};
