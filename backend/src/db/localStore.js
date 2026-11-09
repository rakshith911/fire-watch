import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDirectory = process.env.DATA_DIR_OVERRIDE
  ? path.resolve(process.env.DATA_DIR_OVERRIDE)
  : path.join(os.homedir(), ".firewatch");
const storePath = path.join(dataDirectory, "local-store.json");

let mutationQueue = Promise.resolve();

function emptyStore() {
  return { users: {}, cameras: {} };
}

async function readStore() {
  await fs.mkdir(dataDirectory, { recursive: true });

  try {
    const parsed = JSON.parse(await fs.readFile(storePath, "utf8"));
    return {
      users: parsed.users && typeof parsed.users === "object" ? parsed.users : {},
      cameras: parsed.cameras && typeof parsed.cameras === "object" ? parsed.cameras : {},
    };
  } catch (error) {
    if (error.code === "ENOENT") return emptyStore();
    throw new Error(`Unable to read local FireAI data: ${error.message}`);
  }
}

async function writeStore(store) {
  const temporaryPath = `${storePath}.tmp`;
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(temporaryPath, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(temporaryPath, storePath);
}

function mutateStore(mutator) {
  const operation = mutationQueue.then(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await writeStore(store);
    return result;
  });

  mutationQueue = operation.catch(() => {});
  return operation;
}

function camerasFor(store, userId) {
  if (!Array.isArray(store.cameras[userId])) store.cameras[userId] = [];
  return store.cameras[userId];
}

export async function getUser(userId) {
  const store = await readStore();
  return store.users[userId] || null;
}

export async function createUser(userId, defaultSamplingRate = 30000) {
  return mutateStore((store) => {
    const now = new Date().toISOString();
    const user = {
      userId,
      samplingRate: defaultSamplingRate,
      createdAt: now,
      updatedAt: now,
    };
    store.users[userId] = user;
    return user;
  });
}

export async function ensureUser(userId, defaultSamplingRate = 30000) {
  return mutateStore((store) => {
    const existing = store.users[userId];
    if (existing) return existing;

    const now = new Date().toISOString();
    const user = {
      userId,
      samplingRate: defaultSamplingRate,
      createdAt: now,
      updatedAt: now,
    };
    store.users[userId] = user;
    return user;
  });
}

export async function updateUserSamplingRate(userId, samplingRate) {
  return mutateStore((store) => {
    const now = new Date().toISOString();
    const existing = store.users[userId] || {
      userId,
      createdAt: now,
    };
    const updated = {
      ...existing,
      samplingRate,
      updatedAt: now,
    };
    store.users[userId] = updated;
    return updated;
  });
}

export async function getUserSamplingRate(userId, defaultSamplingRate = 30000) {
  const user = await getUser(userId);
  return user?.samplingRate || defaultSamplingRate;
}

export async function createCamera(userId, cameraData) {
  return mutateStore((store) => {
    const cameras = camerasFor(store, userId);
    let id = Date.now();
    while (cameras.some((camera) => camera.id === id)) id += 1;

    const now = new Date().toISOString();
    const camera = {
      userId,
      id,
      ...cameraData,
      createdAt: now,
      updatedAt: now,
    };
    cameras.push(camera);
    return camera;
  });
}

export async function getCamerasByUserId(userId) {
  const store = await readStore();
  return [...(store.cameras[userId] || [])];
}

export async function getCamera(userId, id) {
  const cameras = await getCamerasByUserId(userId);
  const camera = cameras.find((candidate) => candidate.id === Number(id));
  if (!camera) throw new Error("Camera not found");
  return camera;
}

export async function updateCamera(userId, id, updates) {
  return mutateStore((store) => {
    const cameras = camerasFor(store, userId);
    const index = cameras.findIndex((camera) => camera.id === Number(id));
    if (index === -1) throw new Error("Camera not found");

    const updated = {
      ...cameras[index],
      ...updates,
      userId,
      id: Number(id),
      updatedAt: new Date().toISOString(),
    };
    cameras[index] = updated;
    return updated;
  });
}

export async function deleteCamera(userId, id) {
  return mutateStore((store) => {
    const cameras = camerasFor(store, userId);
    const index = cameras.findIndex((camera) => camera.id === Number(id));
    if (index === -1) throw new Error("Camera not found");
    cameras.splice(index, 1);
    return true;
  });
}

export async function getActiveCameras(userId) {
  const cameras = await getCamerasByUserId(userId);
  return cameras.filter((camera) => camera.isActive === true);
}

export async function getCamerasByIds(userId, cameraIds) {
  const ids = new Set(
    cameraIds
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id))
  );
  const cameras = await getCamerasByUserId(userId);
  return cameras.filter((camera) => ids.has(camera.id));
}

export const localStore = {
  getUser,
  createUser,
  ensureUser,
  updateUserSamplingRate,
  getUserSamplingRate,
  createCamera,
  getCamerasByUserId,
  getCamera,
  updateCamera,
  deleteCamera,
  getActiveCameras,
  getCamerasByIds,
};
