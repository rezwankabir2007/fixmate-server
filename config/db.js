import { MongoClient } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is missing in .env file");
}

export const DATABASE_NAME = "fixmate";
export const mongoClient = new MongoClient(MONGODB_URI);

export function getDatabase() {
  return mongoClient.db(DATABASE_NAME);
}

export async function connectToMongoDB() {
  await mongoClient.connect();
  console.log("Successfully connected to MongoDB!");
  return getDatabase();
}
