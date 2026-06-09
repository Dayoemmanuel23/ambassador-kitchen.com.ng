const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── MongoDB (lazy, cached) ───────────────────────────────────────────────────
let cachedDb = null;
async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  cachedDb = await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  return cachedDb;
}

// ─── Mongoose Schema ──────────────────────────────────────────────────────────
const contactSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    phone: String,
    eventType: String,
    message: String,
    ipAddress: String,
    status: { type: String, enum: ['new', 'read', 'replied'], default: 'new' },
  },
  { timestamps: true }
);
const Contact = mongoose.models.Contact || mongoose.model('Contact', contactSchema);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/api', (req, res) => {
  res.json({ message: 'Ambassador Kitchen API is running!', version: '1.0.0' });
});

app.get('/api/health', async (req, res) => {
  const health = { status: 'OK', timestamp: new Date().toISOString(), db: 'unknown', smtp: 'unknown' };
  try {
    await connectToDatabase();
    health.db = 'connected';
  } catch (e) {
    health.db = 'error: ' + e.message;
  }
  try {
    if (process.env.MAIL_HOST && process.env.MAIL_USER && process.env.MAIL_PASS) {
      health.smtp = 'configured';
    } else {
      health.smtp = 'missing env vars';
    }
  } catch (e) {
    health.smtp = 'error: ' + e.message;
  }
  res.json(health);
});

app.get('/api/_env_status', (req, res) => {
  const keys = ['MONGODB_URI', 'MAIL_HOST', 'MAIL_PORT', 'MAIL_SECURE', 'MAIL_USER', 'MAIL_PASS'];
  res.json(Object.fromEntries(keys.map(k => [k, Boolean(process.env[k])])));
});

app.post('/api/contact', async (req, res) => {
  try {
    await connectToDatabase();
    const { name, email, phone, eventType, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ success: false, message: 'Name, email, and message are required.' });
    }
    const ipAddress = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const newContact = new Contact({ name, email, phone, eventType, message, ipAddress });
    await newContact.save();

    // Send email (non-blocking)
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.MAIL_HOST,
        port: Number(process.env.MAIL_PORT) || 587,
        secure: process.env.MAIL_SECURE === 'true',
        auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
        tls: { rejectUnauthorized: false },
      });
      await transporter.sendMail({
        from: `"Ambassador Kitchen" <${process.env.MAIL_USER}>`,
        to: process.env.MAIL_USER,
        replyTo: email,
        subject: `New Enquiry from ${name}`,
        html: `
          <h2 style="color:#d4af37;">New Contact Form Submission</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
          <p><strong>Phone:</strong> ${phone || 'Not provided'}</p>
          <p><strong>Event Type:</strong> ${eventType || 'Not specified'}</p>
          <p><strong>Message:</strong></p>
          <p style="background:#f9f9f9;padding:12px;border-left:4px solid #d4af37;">${message}</p>
        `,
      });
    } catch (emailErr) {
      console.error('Email failed (contact saved anyway):', emailErr.message);
    }

    res.status(201).json({ success: true, message: 'Your message has been received! We will get back to you shortly.' });
  } catch (error) {
    console.error('Contact POST error:', error.message);
    res.status(500).json({ success: false, message: 'Something went wrong.', error: error.message });
  }
});

// ─── Export for Vercel (no serverless-http needed) ───────────────────────────
module.exports = app;