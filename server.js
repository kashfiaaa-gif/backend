const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());

// Secret key (later move this to .env)
const JWT_SECRET = "change-this-later-to-something-secret";


// ======================
// Temporary "Databases"
// ======================

// Resources
let resources = [
  {
    id: 1,
    topic: "Web Development",
    type: "YouTube",
    title: "Intro to HTML",
    link: "https://example.com"
  }
];

// Users — starts empty. A single admin account gets seeded in below,
// right before the server starts listening, so its password is always
// a real, correctly-generated hash rather than something hardcoded.
let users = [];

// Notes — each note is tied to a userId, so users only ever see their own
let notes = [];


// ======================
// Auth Middleware
// ======================

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
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
// Resource Routes
// ======================

// Get all resources (or by topic) — open to everyone, no login needed
app.get("/api/resources", (req, res) => {
  const topic = req.query.topic;

  if (topic) {
    const filtered = resources.filter(
      r => r.topic.toLowerCase() === topic.toLowerCase()
    );
    return res.json(filtered);
  }

  res.json(resources);
});

// Add a new resource — admin only
app.post("/api/resources", authenticateToken, requireAdmin, (req, res) => {
  const newResource = {
    id: resources.length + 1,
    addedBy: req.user.email,
    ...req.body
  };

  resources.push(newResource);
  res.status(201).json(newResource);
});


// ======================
// Notes Routes
// ======================

// Create a note — tied to whoever is logged in
app.post("/api/notes", authenticateToken, (req, res) => {
  const { topic, content } = req.body;

  const newNote = {
    id: notes.length + 1,
    userId: req.user.id,
    topic,
    content,
    createdAt: new Date()
  };

  notes.push(newNote);
  res.status(201).json(newNote);
});

// Get only the logged-in user's own notes
app.get("/api/notes", authenticateToken, (req, res) => {
  const myNotes = notes.filter(note => note.userId === req.user.id);
  res.json(myNotes);
});


// ======================
// User Authentication
// ======================

// Register — always creates a regular "student" account.
// (Admins are seeded separately, not created through this route.)
app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;

  const existing = users.find(user => user.email === email);

  if (existing) {
    return res.status(400).json({
      error: "User already exists"
    });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = {
    id: users.length + 1,
    email,
    password: hashedPassword,
    role: "student"
  };

  users.push(newUser);

  res.status(201).json({
    id: newUser.id,
    email: newUser.email,
    role: newUser.role
  });
});


// Login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  const user = users.find(user => user.email === email);

  if (!user) {
    return res.status(401).json({
      error: "Invalid email or password"
    });
  }

  const match = await bcrypt.compare(password, user.password);

  if (!match) {
    return res.status(401).json({
      error: "Invalid email or password"
    });
  }

  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role
    },
    JWT_SECRET,
    {
      expiresIn: "1h"
    }
  );

  res.json({
    message: "Login successful",
    token,
    role: user.role
  });
});


// ======================
// Seed one admin account, then start the server
// ======================

async function start() {
  const adminPassword = await bcrypt.hash("admin123", 10);

  users.push({
    id: 1,
    email: "admin@noetra.com",
    password: adminPassword,
    role: "admin"
  });

  const PORT = 3000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Seeded admin login -> email: admin@noetra.com | password: admin123`);
  });
}

start();