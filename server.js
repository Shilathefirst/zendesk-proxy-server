// Zendesk Migration Proxy Server for Render
// This acts as a middleman between your ZAF app and Zendesk API

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

// Enable CORS for all origins (your Zendesk app needs this)
app.use(cors());
app.use(express.json());

// ============================================
// HELPER FUNCTIONS
// ============================================

// Create Zendesk auth credentials
function createZendeskAuth(email, token) {
  return {
    username: `${email}/token`,
    password: token
  };
}

// Delay function for rate limiting
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry logic for failed API calls
async function retryRequest(requestFunc, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestFunc();
    } catch (error) {
      // Handle rate limiting
      if (error.response?.status === 429) {
        const retryAfter = parseInt(error.response.headers['retry-after'] || '60');
        console.log(`Rate limited. Waiting ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        continue;
      }
      
      // If last attempt, throw error
      if (attempt === maxRetries) throw error;
      
      // Exponential backoff
      await sleep(Math.pow(2, attempt) * 1000);
    }
  }
}

// ============================================
// MAIN PROXY ENDPOINT
// ============================================

// Generic proxy for simple API calls
app.post("/proxy", async (req, res) => {
  try {
    const { method, url, data, subdomain, email, token } = req.body;

    // Validate inputs
    if (!subdomain || !email || !token) {
      return res.status(400).json({ 
        error: "Missing credentials",
        message: "subdomain, email, and token are required" 
      });
    }

    if (!url.startsWith("/api/v2/")) {
      return res.status(400).json({ error: "Invalid Zendesk API path" });
    }

    // Make request to Zendesk
    const response = await retryRequest(() => axios({
      method: method || 'GET',
      url: `https://${subdomain}.zendesk.com${url}`,
      data,
      auth: createZendeskAuth(email, token),
      headers: {
        'Content-Type': 'application/json'
      }
    }));

    res.json(response.data);
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(error.response?.status || 500).json({
      error: error.message,
      details: error.response?.data
    });
  }
});

// ============================================
// TEST CONNECTION ENDPOINT
// ============================================

app.post("/api/test", async (req, res) => {
  try {
    const { source, target } = req.body;

    // Test source connection
    const sourceResponse = await retryRequest(() => axios({
      method: 'GET',
      url: `https://${source.subdomain}.zendesk.com/api/v2/users/me.json`,
      auth: createZendeskAuth(source.email, source.token)
    }));

    // Test target connection
    const targetResponse = await retryRequest(() => axios({
      method: 'GET',
      url: `https://${target.subdomain}.zendesk.com/api/v2/users/me.json`,
      auth: createZendeskAuth(target.email, target.token)
    }));

    res.json({
      success: true,
      source: {
        connected: true,
        user: sourceResponse.data.user.name,
        email: sourceResponse.data.user.email
      },
      target: {
        connected: true,
        user: targetResponse.data.user.name,
        email: targetResponse.data.user.email
      }
    });

  } catch (error) {
    console.error('Test connection failed:', error.message);
    res.status(401).json({
      success: false,
      error: 'Connection failed',
      message: error.message,
      details: error.response?.data
    });
  }
});

// ============================================
// MIGRATE SINGLE TICKET ENDPOINT
// ============================================

app.post("/api/migrate-ticket", async (req, res) => {
  try {
    const { ticketId, source, target, options } = req.body;

    console.log(`Migrating ticket #${ticketId}`);

    // 1. Fetch ticket from source
    const ticketResponse = await retryRequest(() => axios({
      method: 'GET',
      url: `https://${source.subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`,
      auth: createZendeskAuth(source.email, source.token)
    }));

    const sourceTicket = ticketResponse.data.ticket;

    // 2. Migrate user if needed
    let requesterId = null;
    if (options.migrateUsers) {
      requesterId = await migrateUser(
        sourceTicket.requester_id,
        source,
        target
      );
    }

    // 3. Prepare ticket data
    const ticketData = {
      ticket: {
        subject: sourceTicket.subject,
        description: sourceTicket.description,
        status: sourceTicket.status,
        priority: sourceTicket.priority,
        type: sourceTicket.type,
        tags: sourceTicket.tags || []
      }
    };

    if (requesterId) {
      ticketData.ticket.requester_id = requesterId;
    }

    // 4. Create ticket (skip if dry run)
    if (options.dryRun) {
      return res.json({
        success: true,
        dryRun: true,
        sourceTicket: {
          id: ticketId,
          subject: sourceTicket.subject
        },
        message: 'Dry run - ticket not created'
      });
    }

    // 5. Create ticket in target
    const createResponse = await retryRequest(() => axios({
      method: 'POST',
      url: `https://${target.subdomain}.zendesk.com/api/v2/tickets.json`,
      auth: createZendeskAuth(target.email, target.token),
      data: ticketData
    }));

    const newTicket = createResponse.data.ticket;

    // 6. Migrate comments if enabled
    if (options.migrateComments) {
      await migrateComments(ticketId, newTicket.id, source, target);
    }

    res.json({
      success: true,
      sourceTicketId: ticketId,
      targetTicketId: newTicket.id,
      subject: sourceTicket.subject
    });

  } catch (error) {
    console.error(`Failed to migrate ticket:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      ticketId: req.body.ticketId
    });
  }
});

// ============================================
// HELPER FUNCTIONS FOR MIGRATION
// ============================================

// User cache to avoid duplicates
const userCache = new Map();

async function migrateUser(userId, source, target) {
  const cacheKey = `${userId}-${source.subdomain}-${target.subdomain}`;
  
  if (userCache.has(cacheKey)) {
    return userCache.get(cacheKey);
  }

  try {
    // Fetch user from source
    const userResponse = await retryRequest(() => axios({
      method: 'GET',
      url: `https://${source.subdomain}.zendesk.com/api/v2/users/${userId}.json`,
      auth: createZendeskAuth(source.email, source.token)
    }));

    const user = userResponse.data.user;

    // Search for user in target
    const searchResponse = await retryRequest(() => axios({
      method: 'GET',
      url: `https://${target.subdomain}.zendesk.com/api/v2/users/search.json?query=${encodeURIComponent(user.email)}`,
      auth: createZendeskAuth(target.email, target.token)
    }));

    // If user exists, return their ID
    if (searchResponse.data.users?.length > 0) {
      const existingId = searchResponse.data.users[0].id;
      userCache.set(cacheKey, existingId);
      return existingId;
    }

    // Create new user
    const createResponse = await retryRequest(() => axios({
      method: 'POST',
      url: `https://${target.subdomain}.zendesk.com/api/v2/users.json`,
      auth: createZendeskAuth(target.email, target.token),
      data: {
        user: {
          name: user.name,
          email: user.email,
          role: user.role === 'admin' ? 'agent' : user.role,
          verified: true
        }
      }
    }));

    const newId = createResponse.data.user.id;
    userCache.set(cacheKey, newId);
    console.log(`Created user: ${user.email}`);
    return newId;

  } catch (error) {
    console.error(`Failed to migrate user ${userId}:`, error.message);
    return null;
  }
}

async function migrateComments(sourceTicketId, targetTicketId, source, target) {
  try {
    // Fetch comments from source
    const commentsResponse = await retryRequest(() => axios({
      method: 'GET',
      url: `https://${source.subdomain}.zendesk.com/api/v2/tickets/${sourceTicketId}/comments.json`,
      auth: createZendeskAuth(source.email, source.token)
    }));

    const comments = commentsResponse.data.comments || [];

    // Add each comment to target
    for (const comment of comments) {
      // Skip system comments
      if (comment.via?.channel === 'api') continue;

      try {
        await retryRequest(() => axios({
          method: 'PUT',
          url: `https://${target.subdomain}.zendesk.com/api/v2/tickets/${targetTicketId}.json`,
          auth: createZendeskAuth(target.email, target.token),
          data: {
            ticket: {
              comment: {
                body: comment.body,
                public: comment.public
              }
            }
          }
        }));

        // Small delay between comments
        await sleep(300);

      } catch (error) {
        console.error(`Failed to migrate comment:`, error.message);
      }
    }

    console.log(`Migrated ${comments.length} comments`);

  } catch (error) {
    console.error(`Failed to migrate comments:`, error.message);
  }
}

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================

app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "Zendesk Migration Proxy",
    endpoints: [
      "POST /proxy - Generic Zendesk API proxy",
      "POST /api/test - Test connections",
      "POST /api/migrate-ticket - Migrate single ticket"
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Zendesk Migration Proxy running on port ${PORT}`);
  console.log(`📡 Ready to handle migration requests`);
});