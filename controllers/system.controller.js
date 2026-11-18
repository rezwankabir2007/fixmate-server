import { getDatabase } from "../config/db.js";

export function getRoot(_req, res) {
  return res.status(200).json({
    success: true,
    message: "Welcome to FixMate Backend API!",
  });
}

export async function getHealth(_req, res) {
  try {
    await getDatabase().command({ ping: 1 });
    return res.status(200).json({
      success: true,
      message: "FixMate API and MongoDB are working!",
    });
  } catch {
    return res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
}
