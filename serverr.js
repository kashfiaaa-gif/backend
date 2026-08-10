require("dotenv").config();

const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("./db");

const app = express();
app.use(express.json());


// ======================
// Temporary "Databases"
// (Notes, bookmarks, and progress are still in-memory for now —
// next step is converting these to real DB tables too.)
// ======================

let notes = [];
let bookmarks = [];
let progress = [];


// ======================
// Auth Middleware
// ======================

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: "Invalid or expired token" });
    }

    req.user = decoded;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admins only" });
  }
  next();
}


// ======================
// Home Route
// ======================

app.get("/", (req, res) => {
  res.send("Hello Kashfia! Backend is running.");
});


// ======================
// Results Routes (roadmap + AI notes for a topic)
// ======================

// Create a topic result — admin only
app.post("/api/results", authenticateToken, requireAdmin, async (req, res) => {
  const { topic_name, roadmap, ai_notes } = req.body;

  const [result] = await pool.query(
    "INSERT INTO saved_results (user_id, topic_name, roadmap, ai_notes) VALUES (?, ?, ?, ?)",
    [req.user.id, topic_name, roadmap, ai_notes]
  );

  res.status(201).json({
    result_id: result.insertId,
    topic_name,
    roadmap,
    ai_notes
  });
});

// List all topic results — open to everyone (just id + name, for browsing)
app.get("/api/results", async (req, res) => {
  const [rows] = await pool.query(
    "SELECT result_id, topic_name FROM saved_results"
  );
  res.json(rows);
});

// Get one topic result in full, with its resources — requires login
// (also logs this lookup to search_history)
app.get("/api/results/:resultId", authenticateToken, async (req, res) => {
  const { resultId } = req.params;

  const [resultRows] = await pool.query(
    "SELECT * FROM saved_results WHERE result_id = ?",
    [resultId]
  );

  if (resultRows.length === 0) {
    return res.status(404).json({ error: "Result not found" });
  }

  const result = resultRows[0];

  const [resourceRows] = await pool.query(
    "SELECT * FROM resources WHERE result_id = ?",
    [resultId]
  );

  await pool.query(
    "INSERT INTO search_history (user_id, topic_name) VALUES (?, ?)",
    [req.user.id, result.topic_name]
  );

  res.json({
    ...result,
    resources: resourceRows
  });
});


// ======================
// Resource Routes (attached to a specific result)
// ======================

// Attach a resource to a topic result — admin only
app.post("/api/results/:resultId/resources", authenticateToken, requireAdmin, async (req, res) => {
  const { resultId } = req.params;
  const { resource_type, resource_title, resource_link } = req.body;

  const [resultRows] = await pool.query(
    "SELECT * FROM saved_results WHERE result_id = ?",
    [resultId]
  );

  if (resultRows.length === 0) {
    return res.status(404).json({ error: "Result not found" });
  }

  const [inserted] = await pool.query(
    "INSERT INTO resources (result_id, resource_type, resource_title, resource_link) VALUES (?, ?, ?, ?)",
    [resultId, resource_type, resource_title, resource_link]
  );

  res.status(201).json({
    resource_id: inserted.insertId,
    result_id: resultId,
    resource_type,
    resource_title,
    resource_link
  });
});


// ======================
// Notes Routes (still in-memory — next to convert)
// ======================

app.post("/api/notes", authenticateToken, async (req, res) => {
  const { topic, content } = req.body;

  const [result] = await pool.query(
    "INSERT INTO notes (user_id, topic_name, note) VALUES (?, ?, ?)",
    [req.user.id, topic, content]
  );

  res.status(201).json({
    note_id: result.insertId,
    topic_name: topic,
    note: content
  });
});

app.get("/api/notes", authenticateToken, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT * FROM notes WHERE user_id = ?",
    [req.user.id]
  );
  res.json(rows);
});

// ======================
// Bookmark Routes (still in-memory — next to convert)
// Resource existence is now checked against the real DB.
// ======================

app.post("/api/bookmarks", authenticateToken, async (req, res) => {
  const { resourceId } = req.body;

  const [resourceRows] = await pool.query(
    "SELECT * FROM resources WHERE resource_id = ?",
    [resourceId]
  );
  if (resourceRows.length === 0) {
    return res.status(404).json({ error: "Resource not found" });
  }

  try {
    const [result] = await pool.query(
      "INSERT INTO bookmarks (user_id, resource_id) VALUES (?, ?)",
      [req.user.id, resourceId]
    );

    res.status(201).json({
      bookmark_id: result.insertId,
      resource: resourceRows[0]
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ error: "Already bookmarked" });
    }
    throw err;
  }
});

app.get("/api/bookmarks", authenticateToken, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT bookmarks.bookmark_id, bookmarks.bookmarked_at, resources.*
     FROM bookmarks
     JOIN resources ON bookmarks.resource_id = resources.resource_id
     WHERE bookmarks.user_id = ?`,
    [req.user.id]
  );
  res.json(rows);
});

// ======================
// Progress Tracking Routes (still in-memory — next to convert)
// ======================

app.post("/api/progress", authenticateToken, async (req, res) => {
  const { topic } = req.body;

  const [existing] = await pool.query(
    "SELECT * FROM progress WHERE user_id = ? AND topic_name = ?",
    [req.user.id, topic]
  );
  if (existing.length > 0) {
    return res.status(400).json({ error: "Topic already tracked" });
  }

  const [result] = await pool.query(
    "INSERT INTO progress (user_id, topic_name, status, progress_percent) VALUES (?, ?, 'Completed', 100)",
    [req.user.id, topic]
  );

  res.status(201).json({
    progress_id: result.insertId,
    topic_name: topic,
    status: "Completed"
  });
});

app.get("/api/progress", authenticateToken, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT * FROM progress WHERE user_id = ?",
    [req.user.id]
  );

  const [countRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM saved_results"
  );
  const totalTopics = countRows[0].total;

  const percentage = totalTopics
    ? Math.round((rows.length / totalTopics) * 100)
    : 0;

  res.json({
    completedTopics: rows,
    totalCompleted: rows.length,
    progressPercentage: percentage
  });
});
// ======================
// User Authentication (real MySQL database)
// ======================

app.post("/api/register", async (req, res) => {
  const { full_name, username, email, password } = req.body;

  const [existing] = await pool.query(
    "SELECT * FROM users WHERE email = ?",
    [email]
  );

  if (existing.length > 0) {
    return res.status(400).json({ error: "User already exists" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const [result] = await pool.query(
    "INSERT INTO users (full_name, username, email, password, role) VALUES (?, ?, ?, ?, 'student')",
    [full_name, username, email, hashedPassword]
  );

  res.status(201).json({
    id: result.insertId,
    email,
    role: "student"
  });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  const [rows] = await pool.query(
    "SELECT * FROM users WHERE email = ?",
    [email]
  );

  if (rows.length === 0) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const user = rows[0];
  const match = await bcrypt.compare(password, user.password);

  if (!match) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = jwt.sign(
    { id: user.user_id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  res.json({ message: "Login successful", token, role: user.role });
});


// ======================
// Start Server
// ======================

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});