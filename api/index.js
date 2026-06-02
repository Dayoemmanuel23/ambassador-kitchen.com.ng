const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB connection (cached)
let cachedDb = null;
async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  cachedDb = await mongoose.connect(process.env.MONGODB_URI);
  return cachedDb;
}

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT),
  secure: process.env.MAIL_SECURE === 'true',
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});

const contactSchema = new mongoose.Schema({
  name: String, email: String, phone: String, eventType: String,
  message: String, ipAddress: String,
  status: { type: String, enum: ['new', 'read', 'replied'], default: 'new' }
}, { timestamps: true });
const Contact = mongoose.models.Contact || mongoose.model('Contact', contactSchema);

app.get('/api/', (req, res) => {
  res.json({ message: 'Catering API is running!', version: '1.0.0' });
});

app.get('/api/test-email', async (req, res) => {
  try {
    await transporter.sendMail({
      from: `"Ambassador Kitchen" <${process.env.MAIL_USER}>`,
      to: process.env.MAIL_USER,
      subject: "SMTP Test Successful ✅",
      text: "SMTP works!"
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/_env_status', (req, res) => {
  const keys = ['MONGODB_URI', 'MAIL_HOST', 'MAIL_PORT', 'MAIL_SECURE', 'MAIL_USER', 'MAIL_PASS'];
  const envPresence = Object.fromEntries(keys.map(key => [key, Boolean(process.env[key])]));
  res.json({ success: true, envPresence });
});

app.post('/api/contact', async (req, res) => {
  await connectToDatabase();
  try {
    const { name, email, phone, eventType, message } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ success: false, message: 'Name, email, and message are required.' });
    }
    const ipAddress = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.socket?.remoteAddress;
    const newContact = new Contact({ name, email, phone, eventType, message, ipAddress });
    await newContact.save();
    await transporter.sendMail({
      from: `"Ambassador Kitchen Contact" <${process.env.MAIL_USER}>`,
      to: process.env.MAIL_USER,
      subject: `New Contact from ${name}`,
      html: `<h2>New Contact</h2><p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>Message:</strong><br>${message}</p>`
    }).catch(e => console.error('Email failed:', e));
    res.status(201).json({ success: true, message: 'Message received!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/health', async (req, res) => {
  await connectToDatabase();
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/api/contacts/count', async (req, res) => {
  await connectToDatabase();
  const count = await Contact.countDocuments();
  res.json({ success: true, count });
});

const serverless = require('serverless-http');
module.exports = serverless(app);