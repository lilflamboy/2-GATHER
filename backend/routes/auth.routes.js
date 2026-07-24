const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { UserProfileModel, getMongoConnected } = require('../models/db');
const { ensureProfile, saveProfile } = require('../services/profile.service');
const { memoryStore } = require('../models/memoryStore');

async function findProfileByEmail(email) {
  if (getMongoConnected()) {
    return await UserProfileModel.findOne({ email });
  }
  return [...memoryStore.profiles.values()].find(p => p.email === email);
}

const JWT_SECRET = process.env.JWT_SECRET || '2-gather-super-secret-key-for-dev';

router.post('/register', async (req, res, next) => {
  try {
    const { email, password, displayName } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const existingUser = await findProfileByEmail(email);
    if (existingUser && existingUser.passwordHash) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    // Create or update profile
    const uid = existingUser ? existingUser.uid : `uid_${Date.now()}_${Math.random().toString(36).substring(2,9)}`;
    const identity = { uid, email, name: displayName || email.split('@')[0] };
    const profile = await ensureProfile(identity);
    
    profile.passwordHash = passwordHash;
    await saveProfile(profile);

    const token = jwt.sign({ uid, email, name: profile.displayName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { uid, email, displayName: profile.displayName } });
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const profile = await findProfileByEmail(email);
    if (!profile || !profile.passwordHash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, profile.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ uid: profile.uid, email, name: profile.displayName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { uid: profile.uid, email, displayName: profile.displayName } });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
