import "dotenv/config";
import {
    CognitoIdentityProviderClient,
    InitiateAuthCommand,
    RespondToAuthChallengeCommand
} from "@aws-sdk/client-cognito-identity-provider";

const client = new CognitoIdentityProviderClient({
    region: process.env.COGNITO_REGION || "us-east-1"
});

const run = async () => {
    const username = "rm6801@nyu.edu";
    // The temporary password you set when creating the user (or the one causing "Force Change")
    const tempPassword = "Password@123";
    // The NEW permanent password you want
    const newPassword = "Password@123";

    const clientId = process.env.COGNITO_CLIENT_ID || "2ulfj1slv1huvl5gjskshbhmtf";

    console.log(`Attempting client-side login for ${username}...`);

    try {
        // 1. Log in to get the Challenge
        const initCommand = new InitiateAuthCommand({
            AuthFlow: "USER_PASSWORD_AUTH",
            ClientId: clientId,
            AuthParameters: {
                USERNAME: username,
                PASSWORD: tempPassword,
            },
        });

        const initResponse = await client.send(initCommand);

        if (initResponse.ChallengeName === "NEW_PASSWORD_REQUIRED") {
            console.log("⚠️  User needs to change password. Setting new confirmed password...");

            // 2. Respond to the challenge
            const respondCommand = new RespondToAuthChallengeCommand({
                ChallengeName: "NEW_PASSWORD_REQUIRED",
                ClientId: clientId,
                ChallengeResponses: {
                    USERNAME: username,
                    NEW_PASSWORD: newPassword,
                },
                Session: initResponse.Session,
            });

            const respondResponse = await client.send(respondCommand);
            console.log("✅ Success! Password changed and user is now CONFIRMED.");
            console.log("👉 You can now log into the app with: " + newPassword);

        } else if (initResponse.AuthenticationResult) {
            console.log("✅ User is already confirmed! No password change needed.");
            console.log("AccessToken:", initResponse.AuthenticationResult.AccessToken.substring(0, 20) + "...");
        } else {
            console.log("Unexpected status:", initResponse);
        }

    } catch (err) {
        console.error("❌ Error:", err.message);
        if (err.message.includes("Incorrect username or password")) {
            console.log("💡 Tip: Are you sure 'Password@123' is the temporary password you set?");
        }
    }
};

run();
