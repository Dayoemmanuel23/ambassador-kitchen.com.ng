const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── MongoDB (lazy connection, cached) ───────────────────────────────────────
let cachedDb = null;
async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  cachedDb = await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  return cachedDb;
}

// ─── Nodemailer (lazy transporter, created on first use) ─────────────────────
function getTransporter() {
  if (
    !process.env.MAIL_HOST ||
    !process.env.MAIL_PORT ||
    !process.env.MAIL_USER ||
    !process.env.MAIL_PASS
  ) {
    throw new Error('SMTP env vars (MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASS) are not fully set');
  }
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT),
    secure: process.env.MAIL_SECURE === 'true',
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    },
    tls: { rejectUnauthorized: false }, // needed for some shared hosting SMTP
  });
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
    status: {
      type: String,
      enum: ['new', 'read', 'replied'],
      default: 'new',
    },
  },
  { timestamps: true }
);
const Contact = mongoose.models.Contact || mongoose.model('Contact', contactSchema);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get(['/api', '/api/'], (req, res) => {
  res.json({ message: 'Catering API is running!', version: '1.0.0' });
});

// Check which env vars are present (values hidden)
app.get('/api/_env_status', (req, res) => {
  const keys = ['MONGODB_URI', 'MAIL_HOST', 'MAIL_PORT', 'MAIL_SECURE', 'MAIL_USER', 'MAIL_PASS'];
  const envPresence = Object.fromEntries(keys.map(key => [key, Boolean(process.env[key])]));
  res.json({ success: true, envPresence });
});

// Test SMTP connection
app.get('/api/test-email', async (req, res) => {
  try {
    const transporter = getTransporter();
    await transporter.verify();
    await transporter.sendMail({
      from: `"Ambassador Kitchen" <${process.env.MAIL_USER}>`,
      to: process.env.MAIL_USER,
      subject: 'SMTP Test Successful ✅',
      text: 'Your SMTP config is working correctly!',
    });
    res.json({ success: true, message: 'Test email sent!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test MongoDB connection
app.get('/api/test-db', async (req, res) => {
  try {
    await connectToDatabase();
    res.json({ success: true, message: 'MongoDB connected!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  const health = { status: 'OK', timestamp: new Date().toISOString(), db: 'unknown', smtp: 'unknown' };
  try { await connectToDatabase(); health.db = 'connected'; } catch (e) { health.db = `error: ${e.message}`; }
  try { getTransporter(); health.smtp = 'configured'; } catch (e) { health.smtp = `error: ${e.message}`; }
  res.json(health);
});

// Contact form submission
app.post('/api/contact', async (req, res) => {
  try {
    await connectToDatabase();

    const { name, email, phone, eventType, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ success: false, message: 'Name, email, and message are required.' });
    }

    const ipAddress =
      req.headers['x-forwarded-for']?.split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      'unknown';

    // Save to MongoDB
    const newContact = new Contact({ name, email, phone, eventType, message, ipAddress });
    await newContact.save();

    // Send email (non-blocking — don't fail the request if email fails)
    try {
      const transporter = getTransporter();
      await transporter.sendMail({
        from: `"Ambassador Kitchen Contact" <${process.env.MAIL_USER}>`,
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
          <hr/>
          <small>Submitted from IP: ${ipAddress}</small>
        `,
      });
    } catch (emailErr) {
      console.error('Email send failed (contact saved):', emailErr.message);
    }

    res.status(201).json({ success: true, message: 'Your message has been received! We will get back to you shortly.' });
  } catch (error) {
    console.error('Contact POST error:', error.message);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.', error: error.message });
  }
});

// Get contact count
app.get('/api/contacts/count', async (req, res) => {
  try {
    await connectToDatabase();
    const count = await Contact.countDocuments();
    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Export for Vercel serverless ────────────────────────────────────────────
const serverless = require('serverless-http');
module.exports = serverless(app);