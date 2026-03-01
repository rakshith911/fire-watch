import { Router } from "express";
import { dynamodb } from "../db/dynamodb.js";
import pino from "pino";

const log = pino({ name: "user-routes" });

export const user = Router();

// Get user settings
user.get("/settings", async (req, res) => {
  try {
    const userId = req.user.sub;

    const userSettings = await dynamodb.getUser(userId);

    if (!userSettings) {
      return res.status(404).json({ error: "User settings not found" });
    }

    log.info({ userId }, "User settings retrieved");

    res.json({
      userId: userSettings.userId,
      createdAt: userSettings.createdAt,
      updatedAt: userSettings.updatedAt,
    });
  } catch (error) {
    log.error({ error: error.message, userId: req.user.sub }, "Failed to get user settings");
    res.status(500).json({ error: "Failed to retrieve user settings" });
  }
});
