
import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is missing in environment variables.");
}

export const DATABASE_NAME = "fixmate";

export const mongoClient = new MongoClient(MONGODB_URI);

let connectionPromise;

export function getDatabase() {
  return mongoClient.db(DATABASE_NAME);
}

export async function connectToMongoDB() {
  if (!connectionPromise) {
    connectionPromise = mongoClient
      .connect()
      .then(() => {
        console.log("Successfully connected to MongoDB!");
        return getDatabase();
      })
      .catch((error) => {
        connectionPromise = undefined;
        throw error;
      });
  }

  return connectionPromise;
}
