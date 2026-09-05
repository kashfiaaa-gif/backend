require("dotenv").config();

const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const pool = require("./db");

const app = express();

app.use(cors());
app.use(express.json());


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
// Dashboard Route
// ======================

app.get("/api/dashboard", authenticateToken, async (req, res) => {
  // Recently viewed topics — last 5 searches, most recent first
  const [recentlyViewed] = await pool.query(
    `SELECT topic_name, searched_at
     FROM search_history
     WHERE user_id = ?
     ORDER BY searched_at DESC
     LIMIT 5`,
    [req.user.id]
  );

  // Topics completed
  const [completed] = await pool.query(
    "SELECT topic_name FROM progress WHERE user_id = ?",
    [req.user.id]
  );
  const completedTopics = completed.map(row => row.topic_name);

  // Continue Learning: viewed topics that aren't in the completed list yet
  const continueLearning = recentlyViewed.filter(
    item => !completedTopics.includes(item.topic_name)
  );

  res.json({
    recentlyViewed,
    continueLearning,
    totalCompleted: completedTopics.length
  });
});


// ======================
// Profile Routes
// ======================

// Get the logged-in user's own profile
app.get("/api/profile", authenticateToken, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT user_id, full_name, username, email, role, created_at FROM users WHERE user_id = ?",
    [req.user.id]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json(rows[0]);
});

// Update the logged-in user's own profile (name, username, email only)
app.put("/api/profile", authenticateToken, async (req, res) => {
  const { full_name, username, email } = req.body;

  try {
    await pool.query(
      "UPDATE users SET full_name = ?, username = ?, email = ? WHERE user_id = ?",
      [full_name, username, email, req.user.id]
    );

    res.json({
      id: req.user.id,
      full_name,
      username,
      email
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ error: "That username or email is already taken" });
    }
    throw err;
  }
});

// ======================
// Admin: List All Users (admin only)
// Add this near your other Profile/User routes in server.js
// ======================

app.get("/api/users", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT user_id, full_name, username, email, role, created_at FROM users ORDER BY created_at DESC"
    );

    res.json(rows);
  } catch (err) {
    console.error("Load users error:", err);
    res.status(500).json({ error: "Could not load users." });
  }
});


// ======================
// Admin: List All Resources (admin only)
// Add this near your other Resource routes in server.js
//
// NOTE: resources doesn't store topic_name itself - it's joined
// in from saved_results via result_id, since admin.js expects
// resource.topic_name on each row.
// ======================

app.get("/api/resources", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT resources.resource_id,
              resources.resource_type,
              resources.resource_title,
              resources.resource_link,
              resources.result_id,
              saved_results.topic_name
       FROM resources
       JOIN saved_results ON resources.result_id = saved_results.result_id
       ORDER BY resources.resource_id DESC`
    );

    res.json(rows);
  } catch (err) {
    console.error("Load resources error:", err);
    res.status(500).json({ error: "Could not load resources." });
  }
});


// ======================
// Roadmap Generator (no AI — matches against admin-curated topics)
// ======================

app.get("/api/generate-roadmap", authenticateToken, async (req, res) => {
  const { topic } = req.query;

  if (!topic) {
    return res.status(400).json({ error: "Please provide a topic" });
  }

  const [matches] = await pool.query(
    "SELECT * FROM saved_results WHERE topic_name LIKE ?",
    [`%${topic}%`]
  );

  if (matches.length === 0) {
    return res.status(404).json({
      error: "No roadmap found for this topic yet. Try browsing available topics, or check back later."
    });
  }

  const result = matches[0];

  const [resourceRows] = await pool.query(
    "SELECT * FROM resources WHERE result_id = ?",
    [result.result_id]
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
// Smart Search
// ======================

app.get("/api/search", async (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({ error: "Please provide a search term" });
  }

  const [topicMatches] = await pool.query(
    "SELECT result_id, topic_name FROM saved_results WHERE topic_name LIKE ?",
    [`%${q}%`]
  );

  const [resourceMatches] = await pool.query(
    `SELECT resources.resource_id, resources.resource_title, resources.resource_type,
            resources.resource_link, saved_results.result_id, saved_results.topic_name
     FROM resources
     JOIN saved_results ON resources.result_id = saved_results.result_id
     WHERE resources.resource_title LIKE ?`,
    [`%${q}%`]
  );

  res.json({
    topics: topicMatches,
    resources: resourceMatches
  });
});


// ======================
// Results Routes (roadmap + AI notes for a topic)
// ======================

// Create a topic result — admin only
app.post("/api/results", authenticateToken, requireAdmin, async (req, res) => {
  const { topic_name, roadmap, ai_notes, difficulty } = req.body;

  const [result] = await pool.query(
    "INSERT INTO saved_results (user_id, topic_name, roadmap, ai_notes, difficulty) VALUES (?, ?, ?, ?, ?)",
    [req.user.id, topic_name, roadmap, ai_notes, difficulty || "Beginner"]
  );

  res.status(201).json({
    result_id: result.insertId,
    topic_name,
    roadmap,
    ai_notes,
    difficulty: difficulty || "Beginner"
  });
});

// List all topic results — open to everyone (just id + name, for browsing)
// Optional ?difficulty=Beginner|Intermediate|Advanced to filter
app.get("/api/results", async (req, res) => {
  const { difficulty } = req.query;

  const query = difficulty
    ? "SELECT result_id, topic_name, difficulty FROM saved_results WHERE difficulty = ?"
    : "SELECT result_id, topic_name, difficulty FROM saved_results";

  const [rows] = await pool.query(query, difficulty ? [difficulty] : []);
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

// Edit a topic result — admin only
app.put("/api/results/:resultId", authenticateToken, requireAdmin, async (req, res) => {
  const { resultId } = req.params;
  const { topic_name, roadmap, ai_notes, difficulty } = req.body;

  const [result] = await pool.query(
    "UPDATE saved_results SET topic_name = ?, roadmap = ?, ai_notes = ?, difficulty = ? WHERE result_id = ?",
    [topic_name, roadmap, ai_notes, difficulty, resultId]
  );

  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "Result not found" });
  }

  res.json({ result_id: Number(resultId), topic_name, roadmap, ai_notes, difficulty });
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

// Edit a resource — admin only
app.put("/api/resources/:resourceId", authenticateToken, requireAdmin, async (req, res) => {
  const { resourceId } = req.params;
  const { resource_type, resource_title, resource_link } = req.body;

  const [existing] = await pool.query(
    "SELECT * FROM resources WHERE resource_id = ?",
    [resourceId]
  );
  if (existing.length === 0) {
    return res.status(404).json({ error: "Resource not found" });
  }

  await pool.query(
    "UPDATE resources SET resource_type = ?, resource_title = ?, resource_link = ? WHERE resource_id = ?",
    [resource_type, resource_title, resource_link, resourceId]
  );

  res.json({
    resource_id: Number(resourceId),
    resource_type,
    resource_title,
    resource_link
  });
});

// Delete a resource — admin only
app.delete("/api/resources/:resourceId", authenticateToken, requireAdmin, async (req, res) => {
  const { resourceId } = req.params;

  const [result] = await pool.query(
    "DELETE FROM resources WHERE resource_id = ?",
    [resourceId]
  );

  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "Resource not found" });
  }

  res.json({ message: "Resource deleted" });
});


// ======================
// Notes Routes
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
 
// Edit one of the logged-in user's own notes
app.put("/api/notes/:noteId", authenticateToken, async (req, res) => {
  const { noteId } = req.params;
  const { topic, content } = req.body;
 
  const [result] = await pool.query(
    "UPDATE notes SET topic_name = ?, note = ? WHERE note_id = ? AND user_id = ?",
    [topic, content, noteId, req.user.id]
  );
 
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "Note not found" });
  }
 
  res.json({ note_id: Number(noteId), topic_name: topic, note: content });
});
 
// Delete one of the logged-in user's own notes
app.delete("/api/notes/:noteId", authenticateToken, async (req, res) => {
  const { noteId } = req.params;
 
  const [result] = await pool.query(
    "DELETE FROM notes WHERE note_id = ? AND user_id = ?",
    [noteId, req.user.id]
  );
 
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "Note not found" });
  }
 
  res.json({ message: "Note deleted" });
});
 
 
// ======================
// Bookmark Routes
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

// Remove one of the logged-in user's own bookmarks
app.delete("/api/bookmarks/:bookmarkId", authenticateToken, async (req, res) => {
  const { bookmarkId } = req.params;

  const [result] = await pool.query(
    "DELETE FROM bookmarks WHERE bookmark_id = ? AND user_id = ?",
    [bookmarkId, req.user.id]
  );

  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "Bookmark not found" });
  }

  res.json({ message: "Bookmark removed" });
});


// ======================
// Progress Tracking Routes
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
// Quiz Routes
// ======================

// Create a quiz — admin only
app.post("/api/quizzes", authenticateToken, requireAdmin, async (req, res) => {
  const { topic_name, quiz_title, description } = req.body;

  const [result] = await pool.query(
    "INSERT INTO quizzes (topic_name, quiz_title, description) VALUES (?, ?, ?)",
    [topic_name, quiz_title, description]
  );

  res.status(201).json({
    quiz_id: result.insertId,
    topic_name,
    quiz_title,
    description
  });
});

// Add a question to a quiz — admin only
app.post("/api/quizzes/:quizId/questions", authenticateToken, requireAdmin, async (req, res) => {
  const { quizId } = req.params;
  const { question_text, option_a, option_b, option_c, option_d, correct_option } = req.body;

  const [quizRows] = await pool.query("SELECT * FROM quizzes WHERE quiz_id = ?", [quizId]);

  if (quizRows.length === 0) {
    return res.status(404).json({ error: "Quiz not found" });
  }

  const [result] = await pool.query(
    `INSERT INTO quiz_questions
     (quiz_id, question_text, option_a, option_b, option_c, option_d, correct_option)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [quizId, question_text, option_a, option_b, option_c, option_d, correct_option]
  );

  res.status(201).json({ question_id: result.insertId, quiz_id: quizId, question_text });
});

// List all quizzes — open to everyone
app.get("/api/quizzes", async (req, res) => {
  const [rows] = await pool.query(
    "SELECT quiz_id, topic_name, quiz_title, description FROM quizzes"
  );
  res.json(rows);
});

// Get one quiz with its questions (no correct answers included) — requires login
app.get("/api/quizzes/:quizId", authenticateToken, async (req, res) => {
  const { quizId } = req.params;

  const [quizRows] = await pool.query("SELECT * FROM quizzes WHERE quiz_id = ?", [quizId]);

  if (quizRows.length === 0) {
    return res.status(404).json({ error: "Quiz not found" });
  }

  const [questionRows] = await pool.query(
    `SELECT question_id, question_text, option_a, option_b, option_c, option_d
     FROM quiz_questions
     WHERE quiz_id = ?`,
    [quizId]
  );

  res.json({ ...quizRows[0], questions: questionRows });
});

// Submit answers for a quiz and get scored
app.post("/api/quizzes/:quizId/submit", authenticateToken, async (req, res) => {
  const { quizId } = req.params;
  const { answers } = req.body; // [{ question_id, selected_option }, ...]

  if (!Array.isArray(answers) || answers.length === 0) {
    return res.status(400).json({ error: "answers must be a non-empty array" });
  }

  // Pull question_text + all four options too, not just correct_option,
  // so the frontend can render a full right/wrong review afterwards.
  const [questions] = await pool.query(
    `SELECT question_id, question_text, option_a, option_b, option_c, option_d, correct_option
     FROM quiz_questions
     WHERE quiz_id = ?`,
    [quizId]
  );

  if (questions.length === 0) {
    return res.status(404).json({ error: "Quiz not found or has no questions" });
  }

  const questionMap = {};
  questions.forEach(q => { questionMap[q.question_id] = q; });

  let score = 0;
  const breakdown = []; // per-question result for the review screen

  for (const answer of answers) {
    const { question_id, selected_option } = answer;
    const question = questionMap[question_id];

    if (!question) continue; // ignore answers for question ids that don't belong to this quiz

    const isCorrect = question.correct_option === selected_option;
    if (isCorrect) score++;

    await pool.query(
      "INSERT INTO quiz_answers (user_id, question_id, selected_option, is_correct) VALUES (?, ?, ?, ?)",
      [req.user.id, question_id, selected_option, isCorrect ? 1 : 0]
    );

    breakdown.push({
      question_id,
      question_text: question.question_text,
      option_a: question.option_a,
      option_b: question.option_b,
      option_c: question.option_c,
      option_d: question.option_d,
      selected_option: selected_option || null,
      correct_option: question.correct_option,
      is_correct: isCorrect
    });
  }

  res.json({
    quiz_id: Number(quizId),
    totalQuestions: questions.length,
    score,
    percentage: Math.round((score / questions.length) * 100),
    breakdown
  });
});

//ETU DUTTA
const crypto = require("crypto");

app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;

  const [userRows] = await pool.query(
    "SELECT * FROM users WHERE email = ?",
    [email]
  );

  if (userRows.length === 0) {
    return res.json({
      message: "If that email exists, a reset link has been sent."
    });
  }

  const user = userRows[0];

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await pool.query(
    "INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)",
    [user.user_id, token, expiresAt]
  );

  console.log(
    `Password reset link for ${email}: http://localhost:3000/reset-password?token=${token}`
  );

  res.json({
    message: "If that email exists, a reset link has been sent."
  });
});

app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  const [resetRows] = await pool.query(
    "SELECT * FROM password_resets WHERE token = ? AND used = FALSE",
    [token]
  );

  if (resetRows.length === 0) {
    return res.status(400).json({
      error: "Invalid or expired reset link"
    });
  }

  const reset = resetRows[0];

  if (new Date(reset.expires_at) < new Date()) {
    return res.status(400).json({
      error: "Reset link has expired"
    });
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);

  await pool.query(
    "UPDATE users SET password = ? WHERE user_id = ?",
    [hashedPassword, reset.user_id]
  );

  await pool.query(
    "UPDATE password_resets SET used = TRUE WHERE reset_id = ?",
    [reset.reset_id]
  );

  res.json({
    message: "Password updated successfully"
  });
});

app.post("/api/resources/:resourceId/rating", authenticateToken, async (req, res) => {
  const { resourceId } = req.params;
  const { rating } = req.body;

  if (rating < 1 || rating > 5) {
    return res.status(400).json({
      error: "Rating must be between 1 and 5"
    });
  }

  await pool.query(
    `INSERT INTO resource_ratings (resource_id, user_id, rating)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE rating = VALUES(rating)`,
    [resourceId, req.user.id, rating]
  );

  res.json({
    message: "Rating saved",
    resourceId,
    rating
  });
});

app.get("/api/resources/:resourceId/rating", async (req, res) => {
  const { resourceId } = req.params;

  const [rows] = await pool.query(
    `SELECT AVG(rating) AS average_rating,
            COUNT(*) AS total_ratings
     FROM resource_ratings
     WHERE resource_id = ?`,
    [resourceId]
  );

  res.json({
    average_rating: rows[0].average_rating
      ? Number(rows[0].average_rating).toFixed(1)
      : null,
    total_ratings: rows[0].total_ratings
  });
});

app.post("/api/results/:resultId/discussions", authenticateToken, async (req, res) => {
  const { resultId } = req.params;
  const { message } = req.body;

  const [result] = await pool.query(
    "INSERT INTO discussions (result_id, user_id, message) VALUES (?, ?, ?)",
    [resultId, req.user.id, message]
  );

  res.status(201).json({
    post_id: result.insertId,
    message
  });
});

app.get("/api/results/:resultId/discussions", authenticateToken, async (req, res) => {
  const { resultId } = req.params;

  const [rows] = await pool.query(
    `SELECT d.post_id,
            d.message,
            d.created_at,
            u.username
     FROM discussions d
     JOIN users u ON d.user_id = u.user_id
     WHERE d.result_id = ?
     ORDER BY d.created_at ASC`,
    [resultId]
  );

  res.json(rows);
});

app.delete("/api/discussions/:postId", authenticateToken, async (req, res) => {
  const { postId } = req.params;

  const [rows] = await pool.query(
    "SELECT * FROM discussions WHERE post_id = ?",
    [postId]
  );

  if (rows.length === 0) {
    return res.status(404).json({
      error: "Post not found"
    });
  }

  const post = rows[0];

  if (
    post.user_id !== req.user.id &&
    req.user.role !== "admin"
  ) {
    return res.status(403).json({
      error: "You can't delete this post"
    });
  }

  await pool.query(
    "DELETE FROM discussions WHERE post_id = ?",
    [postId]
  );

  res.json({
    message: "Post deleted"
  });
});

app.post("/api/interests", authenticateToken, async (req, res) => {
  const { interests } = req.body;

  await pool.query(
    "DELETE FROM user_interests WHERE user_id = ?",
    [req.user.id]
  );

  for (const tag of interests) {
    await pool.query(
      "INSERT INTO user_interests (user_id, interest_tag) VALUES (?, ?)",
      [req.user.id, tag]
    );
  }

  res.json({
    message: "Interests saved",
    interests
  });
});

app.post(
  "/api/results/:resultId/tags",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { resultId } = req.params;
    const { tag } = req.body;

    await pool.query(
      "INSERT INTO result_tags (result_id, tag) VALUES (?, ?)",
      [resultId, tag]
    );

    res.status(201).json({
      result_id: resultId,
      tag
    });
  }
);

app.get("/api/suggestions", authenticateToken, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT DISTINCT sr.result_id, sr.topic_name
     FROM saved_results sr
     JOIN result_tags rt ON sr.result_id = rt.result_id
     JOIN user_interests ui ON rt.tag = ui.interest_tag
     WHERE ui.user_id = ?`,
    [req.user.id]
  );

  res.json(rows);
});





//kashfia

// ======================
// User Authentication
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