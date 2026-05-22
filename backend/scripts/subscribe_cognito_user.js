import {
  SNSClient,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import { makeLogger } from "../src/logger.js";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load .env file from backend root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "..", ".env") });

const log = makeLogger("sns-subscribe");

const snsClient = new SNSClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const SNS_TOPIC_ARN =
  process.env.SNS_TOPIC_ARN || "arn:aws:sns:us-east-1:185329004895:fire-alerts";

// Usage: node scripts/subscribe-cognito-user.js <email> <userId>
const userEmail = process.argv[2];
const userId = process.argv[3];

if (!userEmail || !userId) {
  log.error("❌ Please provide both email address and userId (Cognito sub)");
  log.info("Usage: node scripts/subscribe-cognito-user.js <email> <userId>");
  process.exit(1);
}

async function subscribeUser(email, userId) {
  try {
    // ✅ Subscribe with filter policy to only receive messages for this userId
    // Note: If user is already subscribed, SNS will return the existing subscription
    const filterPolicy = {
      userId: [userId],
    };

    const command = new SubscribeCommand({
      TopicArn: SNS_TOPIC_ARN,
      Protocol: "email",
      Endpoint: email,
      Attributes: {
        FilterPolicy: JSON.stringify(filterPolicy),
      },
    });

    const result = await snsClient.send(command);
    log.info(
      {
        email,
        userId,
        subscriptionArn: result.SubscriptionArn,
        filterPolicy,
      },
      "✅ User subscribed to SNS topic with filter"
    );

    log.info(
      { email, userId },
      "📧 Confirmation email sent - user needs to click link"
    );
    return result.SubscriptionArn;
  } catch (error) {
    log.error(
      {
        email,
        userId,
        error: error.message,
      },
      "❌ Failed to subscribe user"
    );
    throw error;
  }
}

async function main() {
  log.info(
    { email: userEmail, userId },
    "🚀 Subscribing Cognito user to SNS with filter..."
  );

  try {
    await subscribeUser(userEmail, userId);
    log.info("🎉 Subscription complete!");
    log.info("💡 User needs to check email and click confirmation link");
    log.info(`💡 This user will ONLY receive alerts for userId: ${userId}`);
  } catch (error) {
    log.error(error);
    process.exit(1);
  }
}

main();
