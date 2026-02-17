import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { API_URL } from './config';
import './index.css';
import 'katex/dist/katex.min.css';
import katex from 'katex';

// Remember URLs that failed so we never re-request (avoids remount/Strict Mode retries and ERR_BLOCKED loops)
const failedImageUrls = new Set();

function ProblemImage({ url, token }) {
  const [error, setError] = useState(false);
  const [errorStatus, setErrorStatus] = useState(null); // 401, 404, etc.
  const [blobUrl, setBlobUrl] = useState(null);
  const requestKey = url + (token ? '|auth' : '');

  // For /uploads/xxx we load via authenticated API and show as blob URL
  useEffect(() => {
    if (!url || error || failedImageUrls.has(requestKey)) return;
    const isUpload = url.startsWith('/uploads/');
    const pathPart = isUpload ? url.replace(/^\/uploads\/?/, '') : null;
    if (!isUpload || !pathPart || !token) {
      setBlobUrl(undefined);
      return;
    }
    // Keep path for /api/uploads/db/123 (DB) or /api/uploads/filename.png (disk)
    const apiUrl = API_URL + url.replace(/^\/uploads/, '/api/uploads');
    let revoked = false;
    fetch(apiUrl, { headers: { Authorization: 'Bearer ' + token } })
      .then((res) => {
        if (revoked) return null;
        if (!res.ok) {
          setErrorStatus(res.status);
          throw new Error(res.status);
        }
        return res.blob();
      })
      .then((blob) => {
        if (revoked || !blob) return;
        setBlobUrl(URL.createObjectURL(blob));
      })
      .catch((err) => {
        if (!revoked) {
          failedImageUrls.add(requestKey);
          setError(true);
          if (err instanceof Error && err.message && /^\d+$/.test(err.message)) setErrorStatus(Number(err.message));
        }
      });
    return () => {
      revoked = true;
    };
  }, [url, token, requestKey, error]);

  // Revoke blob URL when it changes or on unmount
  const blobUrlRef = useRef(null);
  useEffect(() => {
    const prev = blobUrlRef.current;
    blobUrlRef.current = blobUrl;
    if (prev) URL.revokeObjectURL(prev);
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    };
  }, [blobUrl]);

  const directSrc = url.startsWith('http') ? url : API_URL + (url.startsWith('/') ? url : '/' + url);
  const src = blobUrl != null ? blobUrl : (token && url.startsWith('/uploads/') ? undefined : directSrc);
  const alreadyFailed = failedImageUrls.has(requestKey) || failedImageUrls.has(directSrc);

  // /uploads/ but no token: don't hit direct URL (would 401)
  if (url.startsWith('/uploads/') && !token) {
    return (
      <div className="mt-3 py-4 rounded-lg border border-gray-200 bg-gray-50 text-center text-sm text-gray-500">
        Image unavailable
      </div>
    );
  }

  if (error || alreadyFailed) {
    if (!alreadyFailed) failedImageUrls.add(requestKey);
    const statusHint = errorStatus ? ` (${errorStatus})` : '';
    const extraHint = errorStatus === 404 ? ' — file may be missing on server (try re-uploading).' : '';
    return (
      <div className="mt-3 py-4 rounded-lg border border-gray-200 bg-gray-50 text-center text-sm text-gray-500">
        Image unavailable{statusHint}{extraHint}
      </div>
    );
  }

  // Still loading via fetch (authenticated)
  if (token && url.startsWith('/uploads/') && blobUrl == null && !error) {
    return (
      <div className="mt-3 py-4 rounded-lg border border-gray-200 bg-gray-50 text-center text-sm text-gray-400">
        Loading image…
      </div>
    );
  }

  if (!src) return null;

  return (
    <img
      src={src}
      alt="Problem"
      className="mt-3 max-w-full max-h-64 rounded-lg border object-contain bg-gray-50"
      onError={() => {
        failedImageUrls.add(requestKey);
        failedImageUrls.add(directSrc);
        setError(true);
      }}
    />
  );
}

const App = () => {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [user, setUser] = useState(null);
  const [view, setView] = useState('login');
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [signupForm, setSignupForm] = useState({ username: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  
  const [problems, setProblems] = useState([]);
  const [folders, setFolders] = useState([]);
  const [tags, setTags] = useState([]);
  const [tests, setTests] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [students, setStudents] = useState([]);
  
  const [activeTest, setActiveTest] = useState(null);
  const [testProblems, setTestProblems] = useState([]);
  const [testAnswers, setTestAnswers] = useState({});
  const [timeRemaining, setTimeRemaining] = useState(null);
  const testSubmitRef = useRef({ activeTest: null, testAnswers: {} });
  const handleSubmitTestRef = useRef(() => {});
  
  const [editingProblem, setEditingProblem] = useState(null);
  const [problemToDelete, setProblemToDelete] = useState(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingFolderId, setEditingFolderId] = useState(null);
  const [editingFolderName, setEditingFolderName] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [expandedFolders, setExpandedFolders] = useState(() => new Set()); // folder names (create-test)
  const [adminExpandedFolders, setAdminExpandedFolders] = useState(() => new Set()); // folder IDs expanded in admin (empty = all collapsed)
  const [pdfImportFile, setPdfImportFile] = useState(null);
  const [pdfImportAnswerKey, setPdfImportAnswerKey] = useState('');
  const [pdfImportLoading, setPdfImportLoading] = useState(false);
  const [pdfImportResult, setPdfImportResult] = useState(null);
  const [pdfImportUseAI, setPdfImportUseAI] = useState(true);
  const [newTest, setNewTest] = useState({ name: '', problemIds: [], dueDate: '', timeLimit: 30, testType: 'sprint' });
  const [newStudent, setNewStudent] = useState({ username: '', password: '' });
  const [selectedTestAnalytics, setSelectedTestAnalytics] = useState(null);
  const [selectedProblemIds, setSelectedProblemIds] = useState([]);
  const [bulkMoveFolderId, setBulkMoveFolderId] = useState('');

  // Create axios instance with useMemo to prevent recreation on every render
  const api = useMemo(() => {
    return axios.create({
      baseURL: API_URL,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
  }, [token]);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    setView('login');
    setActiveTest(null);
  }, []);

  const loadUserData = useCallback(async () => {
    try {
      const { data: userData } = await api.get('/api/me');
      setUser(userData);
      
      if (userData.role === 'student') {
        setView('student-dashboard');
        const [testsRes, attemptsRes] = await Promise.all([
          api.get('/api/tests'),
          api.get('/api/attempts')
        ]);
        setTests(testsRes.data);
        setAttempts(attemptsRes.data);
      } else if (userData.role === 'teacher') {
        setView('teacher-dashboard');
        const [problemsRes, testsRes, studentsRes, foldersRes, tagsRes] = await Promise.all([
          api.get('/api/problems'),
          api.get('/api/tests'),
          api.get('/api/students'),
          api.get('/api/folders'),
          api.get('/api/tags')
        ]);
        setProblems(problemsRes.data);
        setTests(testsRes.data);
        setStudents(studentsRes.data);
        setFolders(foldersRes.data);
        setTags(tagsRes.data);
      } else if (userData.role === 'admin') {
        setView('admin-dashboard');
        const [problemsRes, foldersRes, tagsRes] = await Promise.all([
          api.get('/api/problems'),
          api.get('/api/folders'),
          api.get('/api/tags')
        ]);
        setProblems(problemsRes.data);
        setFolders(foldersRes.data);
        setTags(tagsRes.data);
      }
    } catch (error) {
      console.error('Error loading user data:', error);
      handleLogout();
    }
  }, [api, handleLogout]);

  const handleSubmitTest = useCallback(async () => {
    if (!activeTest) return;
    
    try {
      const { data } = await api.post(`/api/tests/${activeTest.id}/submit`, { answers: testAnswers });
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      sessionStorage.removeItem('testInProgress');
      sessionStorage.removeItem('testAnswers_' + activeTest.id);
      alert(`Test submitted! Score: ${data.attempt.score}/${data.attempt.total}\nELO Change: ${data.eloChange >= 0 ? '+' : ''}${data.eloChange}`);
      
      setActiveTest(null);
      setTestAnswers({});
      setTimeRemaining(null);
      setView('student-dashboard');
      loadUserData();
    } catch (error) {
      alert(error.response?.data?.error || 'Error submitting test');
    }
  }, [activeTest, testAnswers, api, loadUserData]);

  handleSubmitTestRef.current = handleSubmitTest;

  // Timer: use persisted start time so reopening tab doesn't reset it
  useEffect(() => {
    if (!activeTest || timeRemaining === null) return;
    if (timeRemaining <= 0) {
      handleSubmitTest();
      return;
    }
    const raw = sessionStorage.getItem('testInProgress');
    const computeRemaining = () => {
      if (raw) {
        try {
          const { startTime, durationMin, testId } = JSON.parse(raw);
          if (testId === activeTest.id) {
            return Math.max(0, Math.ceil((startTime + durationMin * 60 * 1000 - Date.now()) / 1000));
          }
        } catch (_) {}
      }
      return Math.max(0, timeRemaining - 1);
    };
    const next = computeRemaining();
    if (next <= 0) {
      handleSubmitTest();
      return;
    }
    const timer = setTimeout(() => setTimeRemaining(computeRemaining()), 1000);
    return () => clearTimeout(timer);
  }, [timeRemaining, activeTest, handleSubmitTest]);

  // Persist test answers so they survive refresh/reopen
  useEffect(() => {
    if (view === 'taking-test' && activeTest && Object.keys(testAnswers).length > 0) {
      sessionStorage.setItem('testAnswers_' + activeTest.id, JSON.stringify(testAnswers));
    }
  }, [view, activeTest, testAnswers]);

  // Restore in-progress test when student reopens tab or refreshes
  useEffect(() => {
    if (user?.role !== 'student' || !tests.length) return;
    if (view === 'taking-test' && activeTest) return;
    const raw = sessionStorage.getItem('testInProgress');
    if (!raw) return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const { testId, startTime, durationMin, testName, problemIds } = data;
    if (Date.now() > startTime + durationMin * 60 * 1000) {
      sessionStorage.removeItem('testInProgress');
      sessionStorage.removeItem('testAnswers_' + testId);
      return;
    }
    const test = tests.find(t => t.id === testId);
    if (!test) return;
    (async () => {
      try {
        const { data: problemsData } = await api.get('/api/problems');
        const probs = problemIds.map(id => problemsData.find(p => p.id === id)).filter(Boolean);
        const savedAnswers = sessionStorage.getItem('testAnswers_' + testId);
        const answers = savedAnswers ? JSON.parse(savedAnswers) : {};
        setActiveTest(test);
        setTestProblems(probs);
        setTestAnswers(answers);
        setTimeRemaining(Math.max(0, Math.ceil((startTime + durationMin * 60 * 1000 - Date.now()) / 1000)));
        setView('taking-test');
      } catch (_) {}
    })();
  }, [user?.role, tests, api, view, activeTest]);

  // Keep ref updated so beforeunload can submit with latest answers
  useEffect(() => {
    if (view === 'taking-test' && activeTest) {
      testSubmitRef.current = { activeTest, testAnswers };
    }
  }, [view, activeTest, testAnswers]);

  // Lockdown: auto-submit on leave / tab switch
  useEffect(() => {
    if (view !== 'taking-test' || !activeTest) return;
    let leftWhileHidden = false;
    const onBeforeUnload = (e) => {
      const { activeTest: at, testAnswers: ta } = testSubmitRef.current;
      if (at && ta && Object.keys(ta).length >= 0) {
        const t = localStorage.getItem('token');
        if (t) {
          fetch(`${API_URL}/api/tests/${at.id}/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
            body: JSON.stringify({ answers: ta }),
            keepalive: true
          });
        }
      }
      e.preventDefault();
      e.returnValue = '';
    };
    const onVisibilityChange = () => {
      if (document.hidden) leftWhileHidden = true;
      else if (leftWhileHidden) {
        leftWhileHidden = false;
        handleSubmitTestRef.current?.();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [view, activeTest]);

  // Load user data when token changes
  useEffect(() => {
    if (token) {
      loadUserData();
    }
  }, [token, loadUserData]);

  // When entering create-test, all folders start collapsed
  useEffect(() => {
    if (view === 'create-test') {
      setExpandedFolders(new Set());
    }
  }, [view]);

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const { data } = await axios.post(`${API_URL}/api/login`, loginForm);
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
    } catch (error) {
      alert('Invalid credentials');
    }
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    if (!signupForm.username.trim() || !signupForm.password) {
      alert('Please enter username and password');
      return;
    }
    if (signupForm.password.length < 6) {
      alert('Password must be at least 6 characters');
      return;
    }
    try {
      const { data } = await axios.post(`${API_URL}/api/signup`, signupForm);
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
      setSignupForm({ username: '', password: '' });
    } catch (error) {
      alert(error.response?.data?.error || 'Signup failed');
    }
  };

  const katexOptions = {
    displayMode: false,
    throwOnError: false,
    macros: {
      '\\usepackage': '',
    },
    strict: false,
  };

  const RenderLatex = ({ text }) => {
    if (!text) return null;
    const fixLatex = (math) => (math || '').replace(/\\neq\b/g, '\\ne');
    const renderMath = (math, display, key) => {
      try {
        const fixed = fixLatex(math);
        const html = katex.renderToString(fixed, { ...katexOptions, displayMode: display });
        return <span key={key} dangerouslySetInnerHTML={{ __html: html }} />;
      } catch {
        return <span className="text-red-600">[{math}]</span>;
      }
    };
    const parts = [];
    let lastIndex = 0;
    const regex = /\$\$(.+?)\$\$|\$(.+?)\$/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }
      if (match[1]) {
        parts.push(renderMath(match[1], true, match.index));
      } else if (match[2]) {
        parts.push(renderMath(match[2], false, match.index));
      }
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }
    return <>{parts}</>;
  };

  const startTest = async (test) => {
    const hasAttempt = attempts.find(a => a.test_id === test.id);
    if (hasAttempt) {
      alert('You have already completed this test');
      return;
    }

    try {
      const { data: problemsData } = await api.get('/api/problems');
      const problemIds = test.problem_ids || [];
      const testProbs = problemIds.map(id => problemsData.find(p => p.id === id)).filter(Boolean);
      const shuffled = [...testProbs].sort(() => Math.random() - 0.5);
      const startTime = Date.now();
      sessionStorage.setItem('testInProgress', JSON.stringify({
        testId: test.id,
        startTime,
        durationMin: test.time_limit,
        testName: test.name,
        problemIds: shuffled.map(p => p.id)
      }));
      sessionStorage.removeItem('testAnswers_' + test.id);
      
      setActiveTest(test);
      setTestProblems(shuffled);
      setTimeRemaining(test.time_limit * 60);
      setTestAnswers({});
      setView('taking-test');
      try {
        document.documentElement.requestFullscreen?.();
      } catch {
        // Fullscreen optional; user may deny
      }
    } catch (error) {
      alert('Error loading test');
    }
  };

  const createTest = async () => {
    if (!newTest.name || newTest.problemIds.length === 0 || !newTest.dueDate) {
      alert('Please fill in all fields');
      return;
    }

    try {
      await api.post('/api/tests', {
        name: newTest.name,
        problemIds: newTest.problemIds,
        dueDate: newTest.dueDate,
        timeLimit: newTest.timeLimit,
        testType: newTest.testType
      });
      setNewTest({ name: '', problemIds: [], dueDate: '', timeLimit: 30, testType: 'sprint' });
      loadUserData();
      alert('Test created successfully!');
    } catch (error) {
      alert('Error creating test');
    }
  };

  const saveProblem = async () => {
    const question = (editingProblem.question || '').trim();
    const rawAnswer = editingProblem.answer;
    const answerStr = rawAnswer === '' || rawAnswer === undefined || rawAnswer === null
      ? ''
      : String(rawAnswer).trim();

    if (!question) {
      alert('Please enter a question.');
      return;
    }
    if (!answerStr) {
      alert('Please enter an answer (e.g. 42, 3/4, √2, sqrt(2)/2).');
      return;
    }

    const payload = {
      question,
      answer: answerStr,
      topic: (editingProblem.topic ?? '').trim(),
      image_url: editingProblem.image_url || null,
      source: (editingProblem.source ?? '').trim() || null,
      folder_id: editingProblem.folder_id || null,
      tag_ids: editingProblem.tag_ids || []
    };

    try {
      if (editingProblem.id) {
        await api.put(`/api/problems/${editingProblem.id}`, payload);
      } else {
        await api.post('/api/problems', payload);
      }
      setEditingProblem(null);
      loadUserData();
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      let message = typeof data?.error === 'string' ? data.error : error.message || 'Error saving problem';
      if (status === 403) message = 'Admin access required. Only admins can add or edit problems.';
      if (status === 401) message = 'Session expired. Please log in again.';
      if (status && status >= 500 && !message) message = `Server error (${status}). Please try again later.`;
      if (error.code === 'ERR_NETWORK' || !error.response) message = 'Could not reach server. Check your connection and that the backend is running.';
      alert(message);
    }
  };

  const confirmDeleteProblem = async (id) => {
    setProblemToDelete(null);
    try {
      await api.delete(`/api/problems/${id}`);
      loadUserData();
    } catch (error) {
      alert(error.response?.data?.error || 'Error deleting problem');
    }
  };

  const bulkMoveProblems = async () => {
    if (selectedProblemIds.length === 0) return;
    const folderId = bulkMoveFolderId === '' || bulkMoveFolderId === 'uncategorized' ? null : Number(bulkMoveFolderId);
    try {
      await api.put('/api/problems/bulk-move', { ids: selectedProblemIds, folder_id: folderId });
      setSelectedProblemIds([]);
      setBulkMoveFolderId('');
      loadUserData();
    } catch (error) {
      alert(error.response?.data?.error || 'Error moving problems');
    }
  };

  const bulkDeleteProblems = async () => {
    if (selectedProblemIds.length === 0) return;
    if (!confirm(`Delete ${selectedProblemIds.length} selected problem(s)?`)) return;
    try {
      await api.delete('/api/problems/bulk', { data: { ids: selectedProblemIds } });
      setSelectedProblemIds([]);
      loadUserData();
    } catch (error) {
      alert(error.response?.data?.error || 'Error deleting problems');
    }
  };

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      await api.post('/api/folders', { name: newFolderName.trim() });
      setNewFolderName('');
      loadUserData();
    } catch (error) {
      alert(error.response?.data?.error || 'Error creating folder');
    }
  };

  const deleteFolder = async (id) => {
    if (!confirm('Delete this folder? Problems will move to Uncategorized.')) return;
    try {
      await api.delete(`/api/folders/${id}`);
      setAdminExpandedFolders(prev => { const next = new Set(prev); next.delete(id); return next; });
      loadUserData();
    } catch (error) {
      alert(error.response?.data?.error || 'Error deleting folder');
    }
  };

  const updateFolder = async (id) => {
    const name = editingFolderName.trim();
    if (!name) return;
    try {
      await api.put(`/api/folders/${id}`, { name });
      setEditingFolderId(null);
      setEditingFolderName('');
      loadUserData();
    } catch (error) {
      alert(error.response?.data?.error || 'Error updating folder');
    }
  };

  const deleteTag = async (id) => {
    if (!confirm('Delete this tag? It will be removed from all problems.')) return;
    try {
      await api.delete(`/api/tags/${id}`);
      loadUserData();
    } catch (error) {
      alert(error.response?.data?.error || 'Error deleting tag');
    }
  };

  const createTag = async (name) => {
    const n = (name ?? newTagName).trim();
    if (!n) return;
    try {
      await api.post('/api/tags', { name: n });
      setNewTagName('');
      loadUserData();
    } catch (error) {
      alert(error.response?.data?.error || 'Error creating tag');
    }
  };

  const handlePdfImport = async () => {
    if (!pdfImportFile) {
      alert('Select a PDF file first');
      return;
    }
    if (!pdfImportAnswerKey.trim()) {
      alert('Answer key is required. Paste answers (one per line): 1. 42, 2. 3/4, etc.');
      return;
    }
    setPdfImportLoading(true);
    setPdfImportResult(null);
    try {
      const formData = new FormData();
      formData.append('pdf', pdfImportFile);
      if (pdfImportAnswerKey.trim()) formData.append('answerKey', pdfImportAnswerKey.trim());
      formData.append('useAI', pdfImportUseAI ? 'true' : 'false');
      const { data } = await api.post('/api/import-pdf', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 300000, // 5 min (Render free tier limit)
      });
      setPdfImportResult(data);
      setPdfImportFile(null);
      setPdfImportAnswerKey('');
      const input = document.getElementById('pdf-import-input');
      if (input) input.value = '';
      loadUserData();
    } catch (error) {
      setPdfImportResult({ error: error.response?.data?.error || error.message || 'Import failed' });
    } finally {
      setPdfImportLoading(false);
    }
  };

  const loadTestAnalytics = async (testId) => {
    try {
      const { data } = await api.get(`/api/tests/${testId}/attempts`);
      setSelectedTestAnalytics({ testId, attempts: data });
    } catch (error) {
      alert('Error loading analytics');
    }
  };

  const registerStudent = async () => {
    const username = newStudent.username.trim();
    const password = newStudent.password;
    if (!username || !password) {
      alert('Enter username and password');
      return;
    }
    try {
      await api.post('/api/students', { username, password });
      setNewStudent({ username: '', password: '' });
      const { data } = await api.get('/api/students');
      setStudents(data);
    } catch (error) {
      alert(error.response?.data?.error || 'Failed to register student');
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

if (view === 'login') {
  return (
    <div className="login-page">
      {/* Logo */}
      <div className="logo">
        <span className="logo-text">DDMTP</span>
        <div className="logo-icon">
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>

      {/* Login Card */}
      <div className="login-card">
        <h1>Login</h1>
        <p className="subtitle">Log in to take your test!</p>

        <form onSubmit={handleLogin}>
          <input
            type="text"
            placeholder="Username*"
            value={loginForm.username}
            onChange={(e) =>
              setLoginForm({ ...loginForm, username: e.target.value })
            }
            required
          />

          <div className="password-wrapper">
            <input
              type={showPassword ? 'text' : 'password'}
              placeholder="Password*"
              value={loginForm.password}
              onChange={(e) =>
                setLoginForm({ ...loginForm, password: e.target.value })
              }
              required
            />
            <button
              type="button"
              className="toggle-password"
              onClick={() => setShowPassword(!showPassword)}
              aria-label="Toggle password visibility"
            >
              👁
            </button>
          </div>


          <button type="submit" className="login-btn">
            Log in
          </button>
        </form>
      </div>

      {/* Sign up */}
      <div className="signup">
        New teacher? <button type="button" onClick={() => setView('signup')} className="text-[#007f8f] hover:underline font-medium">Sign up</button>
      </div>

      {/* Footer */}
      <footer className="footer">
        <a href="#">Help</a>
      </footer>
    </div>
  );
}

if (view === 'signup') {
  return (
    <div className="login-page">
      {/* Logo */}
      <div className="logo">
        <span className="logo-text">DDMTP</span>
        <div className="logo-icon">
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>

      {/* Signup Card */}
      <div className="login-card">
        <h1>Teacher Sign Up</h1>
        <p className="subtitle">Create your teacher account</p>

        <form onSubmit={handleSignup}>
          <input
            type="text"
            placeholder="Username*"
            value={signupForm.username}
            onChange={(e) =>
              setSignupForm({ ...signupForm, username: e.target.value })
            }
            required
          />

          <div className="password-wrapper">
            <input
              type={showSignupPassword ? 'text' : 'password'}
              placeholder="Password (min 6 characters)*"
              value={signupForm.password}
              onChange={(e) =>
                setSignupForm({ ...signupForm, password: e.target.value })
              }
              required
            />
            <button
              type="button"
              className="toggle-password"
              onClick={() => setShowSignupPassword(!showSignupPassword)}
              aria-label="Toggle password visibility"
            >
              👁
            </button>
          </div>

          <button type="submit" className="login-btn">
            Sign up
          </button>
        </form>
      </div>

      {/* Back to login */}
      <div className="signup">
        Already have an account? <button type="button" onClick={() => setView('login')} className="text-[#007f8f] hover:underline font-medium">Log in</button>
      </div>

      {/* Footer */}
      <footer className="footer">
        <a href="#">Help</a>
      </footer>
    </div>
  );
}

if (view === 'taking-test' && activeTest) {
  return (
    <div className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-4xl p-6">

        {/* Header */}
        <div className="sticky top-0 z-50 mb-6">
          <div className="bg-white rounded-xl shadow px-6 py-4 flex items-center justify-between">
            <div className="w-1/4" />
            <h2 className="text-xl font-semibold text-gray-800 text-center flex-1">
              {activeTest.name}
            </h2>
            <div className="w-1/4 flex justify-end">
              <div
                className={`px-4 py-2 rounded-lg font-semibold text-sm ${
                  timeRemaining < 60
                    ? 'bg-red-100 text-red-700'
                    : 'bg-[#e6f6f7] text-[#007f8f]'
                }`}
              >
                {formatTime(timeRemaining)}
              </div>
            </div>
          </div>
        </div>

        {/* Lockdown warning — prominent */}
        <div className="mb-4 rounded-xl border-2 border-amber-500 bg-amber-100 px-4 py-4 text-center text-base font-semibold text-amber-900 shadow-sm">
          ⚠ Do not reload, switch tabs, exit, or go back. If you do, your answers will be auto-submitted immediately.
        </div>

        {/* Time warning */}
        {timeRemaining < 60 && (
          <div className="mb-4">
            <div className="bg-red-50 border border-red-200 text-red-700 px-6 py-4 rounded-xl text-center text-sm">
              Less than 1 minute remaining. Please submit soon.
            </div>
          </div>
        )}

        {/* Questions */}
        <div className="space-y-4">
          {testProblems.map((problem, index) => (
            <div key={problem.id} className="bg-white rounded-xl shadow p-6">
              <div className="mb-4">
                <span className="text-xs font-medium text-gray-500">
                  Question {index + 1} of {testProblems.length}
                </span>
                {problem.source && (
                  <p className="text-xs text-gray-500 mt-0.5">Source: {problem.source}</p>
                )}
                <h3 className="text-base font-semibold text-gray-800 mt-1">
                  <RenderLatex text={problem.question} />
                </h3>
                {problem.image_url && (
                  <ProblemImage url={problem.image_url} token={token} />
                )}
              </div>

              <input
                type="text"
                value={testAnswers[problem.id] || ''}
                onChange={(e) =>
                  setTestAnswers({
                    ...testAnswers,
                    [problem.id]: e.target.value
                  })
                }
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:border-[#00A3AD] focus:outline-none text-center text-sm"
                placeholder="e.g. 42, 3/4, √2, √2/2"
              />
            </div>
          ))}
        </div>

        {/* Submit */}
        <div className="mt-6">
          <button
            onClick={handleSubmitTest}
            className="w-full bg-[#007f8f] hover:bg-[#006b78] text-white py-3 rounded-lg font-semibold"
          >
            Submit Test
          </button>
        </div>
      </div>
    </div>
  );
}


if (view === 'student-dashboard' && user) {
  const availableTests = tests.filter(
    (t) => !attempts.find((a) => a.test_id === t.id)
  );

  return (
    <div className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-6xl p-6">

        {/* Top Nav */}
        <div className="bg-white rounded-xl shadow mb-6 px-6 py-4 flex items-center justify-between">
          <div className="w-1/4" />
          <h1 className="text-xl font-semibold text-gray-800 text-center flex-1">
            Student Portal
          </h1>
          <div className="w-1/4 flex justify-end">
            <button
              onClick={handleLogout}
              className="text-sm text-[#007f8f] font-medium hover:underline"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Welcome Card */}
        <div className="bg-white rounded-xl shadow p-6 mb-6 text-center">
          <h2 className="text-2xl font-semibold text-gray-800 mb-1">
            Welcome, {user.username}
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Here’s a snapshot of your progress
          </p>

          <div className="flex flex-wrap gap-4 justify-center">
            <div className="inline-flex flex-col items-center bg-[#e6f6f7] px-6 py-4 rounded-xl">
              <span className="text-xs text-gray-600 mb-1">Overall ELO</span>
              <span className="text-4xl font-bold text-[#007f8f]">
                {user.elo}
              </span>
            </div>
            {typeof user.mathcounts_score === 'number' && (
              <div className="inline-flex flex-col items-center bg-white border border-gray-200 px-6 py-4 rounded-xl">
                <span className="text-xs text-gray-600 mb-1">MATHCOUNTS Score</span>
                <span className="text-4xl font-bold text-[#007f8f]">
                  {user.mathcounts_score}
                </span>
              </div>
            )}
            {user.tag_elos?.length > 0 && (
              <div className="inline-flex flex-col items-start bg-white border border-gray-200 px-4 py-3 rounded-xl">
                <span className="text-xs text-gray-600 mb-2">By Subject</span>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {user.tag_elos.map(t => (
                    <span key={t.name} className="text-gray-800">
                      {t.name}: <span className="font-semibold text-[#007f8f]">{t.elo}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="grid md:grid-cols-2 gap-6">

          {/* Available Tests */}
          <div>
            <h3 className="text-lg font-semibold mb-4 text-gray-800">
              Available Tests
            </h3>

            {availableTests.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-gray-500 text-center">
                No tests available
              </div>
            ) : (
              <div className="space-y-3">
                {availableTests.map((test) => (
                  <div key={test.id} className="bg-white rounded-xl shadow p-4">
                    <h4 className="font-semibold text-gray-800 mb-1">
                      {test.name}
                    </h4>
                    <p className="text-sm text-gray-500 mb-3">
                      {(test.problem_ids || []).length} questions •{' '}
                      {test.time_limit} min
                    </p>
                    <button
                      onClick={() => startTest(test)}
                      className="w-full bg-[#007f8f] hover:bg-[#006b78] text-white py-2 rounded-lg text-sm font-medium"
                    >
                      Start Test
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Test History */}
          <div>
            <h3 className="text-lg font-semibold mb-4 text-gray-800">
              Test History
            </h3>

            {attempts.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-gray-500 text-center">
                No completed tests
              </div>
            ) : (
              <div className="space-y-3">
                {attempts.map((attempt) => {
                  const test = tests.find(
                    (t) => t.id === attempt.test_id
                  );
                  const delta = attempt.elo_after - attempt.elo_before;

                  return (
                    <div
                      key={attempt.id}
                      className="bg-white rounded-xl shadow p-4"
                    >
                      <h4 className="font-semibold text-gray-800 mb-1">
                        {test?.name || 'Unknown Test'}
                      </h4>
                      <p className="text-sm text-gray-500">
                        Score: {attempt.score}/{attempt.total} (
                        {Math.round(
                          (attempt.score / attempt.total) * 100
                        )}
                        %)
                      </p>
                      <p
                        className={`text-sm font-medium ${
                          delta >= 0
                            ? 'text-green-600'
                            : 'text-red-600'
                        }`}
                      >
                        ELO {delta >= 0 ? '+' : ''}
                        {delta}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


if (view === 'teacher-dashboard' && user) {
  return (
    <div className="min-h-screen bg-[#f5f7f8]">
      {/* Top Nav */}
      <div className="sticky top-0 z-50 bg-white shadow">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <h1 className="text-lg font-semibold text-gray-800">
            Teacher Dashboard
          </h1>
          <button
            onClick={handleLogout}
            className="text-sm text-[#007f8f] font-medium hover:underline"
          >
            Logout
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="mb-6 flex gap-3">
          <button
            onClick={() => setView('register-students')}
            className="bg-[#007f8f] hover:bg-[#006b78] text-white px-6 py-3 rounded-lg font-medium"
          >
            Register Students
          </button>
          <button
            onClick={() => setView('create-test')}
            className="bg-[#007f8f] hover:bg-[#006b78] text-white px-6 py-3 rounded-lg font-medium"
          >
            Create New Test
          </button>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Tests */}
          <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-800">
              Your Tests
            </h2>

            {tests.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-center text-gray-500">
                No tests created yet
              </div>
            ) : (
              <div className="space-y-3">
                {tests.map(test => (
                  <div key={test.id} className="bg-white rounded-xl shadow p-4">
                    <h3 className="font-medium text-gray-800 mb-1">
                      {test.name}
                    </h3>
                    <p className="text-sm text-gray-500 mb-3">
                      {(test.problem_ids || []).length} questions • {test.time_limit} min
                    </p>

                    <button
                      onClick={async () => {
                        await loadTestAnalytics(test.id);
                        setView('test-analytics');
                      }}
                      className="text-sm text-[#007f8f] font-medium hover:underline"
                    >
                      View Analytics →
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* My students (only students you registered) */}
          <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-800">
              My Students
            </h2>
            <p className="text-sm text-gray-500 mb-3">
              Only students you register can see your tests. Use the Register Students button to add students.
            </p>
            <div className="bg-white rounded-xl shadow divide-y">
              {students.length === 0 ? (
                <div className="p-6 text-center text-gray-500 text-sm">
                  No students yet. <button type="button" onClick={() => setView('register-students')} className="text-[#007f8f] font-medium hover:underline">Register students</button> to get started.
                </div>
              ) : (
                students.map((s, i) => (
                  <div key={s.id} className="p-4">
                    <div className="flex justify-between items-center">
                      <span className="font-medium">{i + 1}. {s.username}</span>
                      <div className="flex gap-4">
                        {typeof s.mathcounts_score === 'number' && (
                          <span className="text-gray-600">MATHCOUNTS: <span className="font-semibold text-[#007f8f]">{s.mathcounts_score}</span></span>
                        )}
                        <span className="text-[#007f8f] font-semibold">ELO: {s.elo}</span>
                      </div>
                    </div>
                    {s.tag_elos?.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600">
                        {s.tag_elos.map(t => (
                          <span key={t.name}>{t.name}: <span className="font-medium text-[#007f8f]">{t.elo}</span></span>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

if (view === 'test-analytics' && user && selectedTestAnalytics) {
  const test = tests.find(t => t.id === selectedTestAnalytics.testId);
  const attempts = selectedTestAnalytics.attempts || [];
  const problemIds = test?.problem_ids || [];

  // Student accuracies (already have score/total per attempt)
  const studentAccuracies = attempts.map(a => ({
    username: a.username,
    score: a.score,
    total: a.total,
    accuracy: a.total > 0 ? Math.round((a.score / a.total) * 100) : 0
  }));

  // Most missed problems: count wrong answers per problem
  const missCount = {};
  for (const pid of problemIds) missCount[pid] = 0;
  for (const a of attempts) {
    const results = typeof a.results === 'string' ? JSON.parse(a.results) : (a.results || {});
    for (const pid of problemIds) {
      if (results[pid] === false) missCount[pid]++;
    }
  }

  // Group by topic (tag) - a problem can have multiple tags
  const byTopic = {};
  for (const pid of problemIds) {
    const p = problems.find(pr => pr.id === pid);
    const tags = (p?.tag_names?.length) ? p.tag_names : ['Untagged'];
    for (const tag of tags) {
      if (!byTopic[tag]) byTopic[tag] = [];
      byTopic[tag].push({ ...p, id: pid, missCount: missCount[pid] || 0 });
    }
  }
  for (const tag of Object.keys(byTopic)) {
    byTopic[tag].sort((a, b) => (b.missCount || 0) - (a.missCount || 0));
  }

  return (
    <div className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-4xl p-6">
        <div className="bg-white rounded-xl shadow p-6 mb-6 flex justify-between items-center">
          <button
            onClick={() => setView('teacher-dashboard')}
            className="text-sm text-[#007f8f] hover:underline"
          >
            ← Back to Dashboard
          </button>
          <h1 className="text-lg font-semibold text-gray-800">
            Analytics: {test?.name || 'Test'}
          </h1>
          <span />
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-base font-semibold text-gray-800 mb-4">Student Accuracies</h2>
            {studentAccuracies.length === 0 ? (
              <p className="text-gray-500 text-sm">No attempts yet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-600 border-b">
                      <th className="pb-2 pr-4">Student</th>
                      <th className="pb-2 pr-4">Score</th>
                      <th className="pb-2">Accuracy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {studentAccuracies.map((s, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-2 pr-4 font-medium">{s.username}</td>
                        <td className="py-2 pr-4">{s.score}/{s.total}</td>
                        <td className="py-2">{s.accuracy}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-base font-semibold text-gray-800 mb-4">Most Missed Problems by Topic</h2>
            {Object.keys(byTopic).length === 0 ? (
              <p className="text-gray-500 text-sm">No problems in this test</p>
            ) : (
              <div className="space-y-4">
                {Object.entries(byTopic).sort(([a], [b]) => a.localeCompare(b)).map(([topic, probs]) => (
                  <div key={topic}>
                    <h3 className="font-medium text-gray-700 mb-2 text-sm">{topic}</h3>
                    <div className="space-y-1.5 pl-3 border-l-2 border-gray-200">
                      {probs.map(p => (
                        <div key={p.id} className="flex justify-between text-sm">
                          <span className="text-gray-800">{p.source || `Problem #${p.id}`}</span>
                          <span className="text-red-600 font-medium">{p.missCount} missed</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

if (view === 'register-students' && user) {
  return (
    <div className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-2xl p-6">
        <div className="bg-white rounded-xl shadow p-6 mb-6 flex justify-between items-center">
          <button
            onClick={() => setView('teacher-dashboard')}
            className="text-sm text-[#007f8f] hover:underline"
          >
            ← Back to Dashboard
          </button>
          <h1 className="text-lg font-semibold text-gray-800">
            Register Students
          </h1>
          <span />
        </div>

        <div className="bg-white rounded-xl shadow p-6 mb-6">
          <h2 className="text-base font-semibold text-gray-800 mb-4">Add a student</h2>
          <div className="flex flex-wrap gap-3 items-end">
            <input
              type="text"
              placeholder="Username"
              value={newStudent.username}
              onChange={(e) => setNewStudent({ ...newStudent, username: e.target.value })}
              className="border rounded-lg px-4 py-2 flex-1 min-w-[120px]"
            />
            <input
              type="password"
              placeholder="Password"
              value={newStudent.password}
              onChange={(e) => setNewStudent({ ...newStudent, password: e.target.value })}
              className="border rounded-lg px-4 py-2 flex-1 min-w-[120px]"
            />
            <button
              type="button"
              onClick={() => registerStudent()}
              className="bg-[#007f8f] hover:bg-[#006b78] text-white px-5 py-2 rounded-lg font-medium"
            >
              Add student
            </button>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow">
          <h2 className="text-base font-semibold text-gray-800 p-4 pb-2">My students</h2>
          <p className="text-sm text-gray-500 px-4 pb-4">
            Only these students can see and take your tests.
          </p>
          <div className="divide-y">
            {students.length === 0 ? (
              <div className="p-6 text-center text-gray-500 text-sm">
                No students yet. Add one above.
              </div>
            ) : (
              students.map((s, i) => (
                <div key={s.id} className="p-4">
                  <div className="flex justify-between items-center">
                    <span className="font-medium">{i + 1}. {s.username}</span>
                    <div className="flex gap-4">
                      {typeof s.mathcounts_score === 'number' && (
                        <span className="text-gray-600">MATHCOUNTS: <span className="font-semibold text-[#007f8f]">{s.mathcounts_score}</span></span>
                      )}
                      <span className="text-[#007f8f] font-semibold">ELO: {s.elo}</span>
                    </div>
                  </div>
                  {s.tag_elos?.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600">
                      {s.tag_elos.map(t => (
                        <span key={t.name}>{t.name}: <span className="font-medium text-[#007f8f]">{t.elo}</span></span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

if (view === 'create-test' && user) {
  return (
    <div className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-4xl p-6">
        <div className="bg-white rounded-xl shadow p-6 mb-6 flex justify-between items-center">
          <button
            onClick={() => setView('teacher-dashboard')}
            className="text-sm text-[#007f8f] hover:underline"
          >
            ← Back
          </button>
          <h1 className="text-lg font-semibold text-gray-800">
            Create New Test
          </h1>
          <span />
        </div>

        <div className="bg-white rounded-xl shadow p-8 space-y-6">
          <input
            className="w-full border rounded-lg px-4 py-3"
            placeholder="Test name"
            value={newTest.name}
            onChange={(e) => setNewTest({ ...newTest, name: e.target.value })}
          />

          <div className="grid grid-cols-2 gap-4">
            <input
              type="date"
              className="border rounded-lg px-4 py-3"
              value={newTest.dueDate}
              onChange={(e) => setNewTest({ ...newTest, dueDate: e.target.value })}
            />
            <input
              type="number"
              className="border rounded-lg px-4 py-3"
              value={newTest.timeLimit}
              onChange={(e) =>
                setNewTest({ ...newTest, timeLimit: +e.target.value || 30 })
              }
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Test type</label>
            <div className="flex gap-6">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="testType"
                  checked={newTest.testType === 'sprint'}
                  onChange={() => setNewTest({ ...newTest, testType: 'sprint' })}
                  className="mt-1"
                />
                <div>
                  <span className="font-medium text-gray-800">Sprint</span>
                  <p className="text-sm text-gray-500 mt-0.5">30 problems, 1 point each. Counts toward MATHCOUNTS score as 1× correct answers.</p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="testType"
                  checked={newTest.testType === 'target'}
                  onChange={() => setNewTest({ ...newTest, testType: 'target' })}
                  className="mt-1"
                />
                <div>
                  <span className="font-medium text-gray-800">Target</span>
                  <p className="text-sm text-gray-500 mt-0.5">8 problems, 2 points each. Counts toward MATHCOUNTS score as 2× correct answers.</p>
                </div>
              </label>
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto border rounded-lg p-4 space-y-1">
            {(() => {
              const byFolder = {};
              for (const p of problems) {
                const fname = p.folder_name || 'Uncategorized';
                if (!byFolder[fname]) byFolder[fname] = [];
                byFolder[fname].push(p);
              }
              const folderNames = Object.keys(byFolder).sort();
              return folderNames.map(fname => {
                const isExpanded = expandedFolders.has(fname);
                const toggle = () => setExpandedFolders(prev => {
                  const next = new Set(prev);
                  if (next.has(fname)) next.delete(fname);
                  else next.add(fname);
                  return next;
                });
                const folderProbs = byFolder[fname];
                const folderIds = folderProbs.map(p => p.id);
                const allSelected = folderIds.length > 0 && folderIds.every(id => newTest.problemIds.includes(id));
                const someSelected = folderIds.some(id => newTest.problemIds.includes(id));
                const toggleFolderSelection = (e) => {
                  e.stopPropagation();
                  if (allSelected) {
                    setNewTest({ ...newTest, problemIds: newTest.problemIds.filter(id => !folderIds.includes(id)) });
                  } else {
                    setNewTest({ ...newTest, problemIds: [...new Set([...newTest.problemIds, ...folderIds])] });
                  }
                };
                return (
                  <div key={fname} className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="w-full flex items-center px-4 py-2.5 bg-gray-50 hover:bg-gray-100">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
                        onChange={toggleFolderSelection}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-shrink-0 mr-2"
                      />
                      <button
                        type="button"
                        onClick={toggle}
                        className="flex-1 flex items-center justify-between text-left font-semibold text-gray-700 text-sm"
                      >
                        <span>{fname}</span>
                        <span className="text-gray-400">{isExpanded ? '▼' : '▶'}</span>
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="border-t border-gray-200 p-3 space-y-2">
                        {folderProbs.map(p => (
                          <label key={p.id} className="flex gap-3 text-sm items-center cursor-pointer hover:bg-gray-50 -mx-1 px-2 py-1.5 rounded">
                            <input
                              type="checkbox"
                              checked={newTest.problemIds.includes(p.id)}
                              onChange={(e) =>
                                setNewTest({
                                  ...newTest,
                                  problemIds: e.target.checked
                                    ? [...newTest.problemIds, p.id]
                                    : newTest.problemIds.filter(id => id !== p.id)
                                })
                              }
                              className="flex-shrink-0"
                            />
                            <span className="flex-1 min-w-0 text-gray-700">
                              <span className="font-medium">{p.source || `Problem #${p.id}`}</span>
                              {p.tag_names?.length > 0 && (
                                <span className="text-gray-500 ml-1">[{p.tag_names.join(', ')}]</span>
                              )}
                              <span className="text-[#007f8f] font-medium ml-2">ELO {p.elo}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              });
            })()}
          </div>

          <button
            onClick={createTest}
            className="w-full bg-[#007f8f] hover:bg-[#006b78] text-white py-3 rounded-lg font-medium"
          >
            Create Test
          </button>
        </div>
      </div>
    </div>
  );
}

if (view === 'admin-dashboard' && user) {
  return (
    <div className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-6xl p-6">
        <div className="bg-white rounded-xl shadow p-4 mb-6 flex justify-between">
          <h1 className="font-semibold text-gray-800">Admin Portal</h1>
          <button
            onClick={handleLogout}
            className="text-sm text-[#007f8f] hover:underline"
          >
            Logout
          </button>
        </div>

        <div className="mb-6 p-4 bg-white rounded-xl shadow">
          <h3 className="font-semibold text-gray-800 mb-3">Folders</h3>
          <div className="flex flex-wrap gap-2 mb-3">
            {folders.map(f => (
              <span key={f.id} className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-gray-100 text-sm">
                {editingFolderId === f.id ? (
                  <>
                    <input
                      type="text"
                      value={editingFolderName}
                      onChange={(e) => setEditingFolderName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') updateFolder(f.id); if (e.key === 'Escape') { setEditingFolderId(null); setEditingFolderName(''); } }}
                      className="w-32 px-1 py-0.5 border rounded text-sm"
                      autoFocus
                    />
                    <button type="button" onClick={() => updateFolder(f.id)} className="text-[#007f8f] hover:underline text-xs">✓</button>
                    <button type="button" onClick={() => { setEditingFolderId(null); setEditingFolderName(''); }} className="text-gray-500 hover:underline text-xs">✗</button>
                  </>
                ) : (
                  <>
                    {f.name}
                    <button type="button" onClick={() => { setEditingFolderId(f.id); setEditingFolderName(f.name); }} className="text-[#007f8f] hover:underline text-xs">edit</button>
                    <button type="button" onClick={() => deleteFolder(f.id)} className="text-red-600 hover:underline text-xs">×</button>
                  </>
                )}
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="New folder name"
              className="flex-1 px-3 py-2 border rounded-lg text-sm"
            />
            <button type="button" onClick={createFolder} className="px-4 py-2 bg-[#007f8f] text-white rounded-lg text-sm">Add</button>
          </div>
        </div>

        <div className="mb-6 p-4 bg-white rounded-xl shadow">
          <h3 className="font-semibold text-gray-800 mb-3">Tags</h3>
          <div className="flex flex-wrap gap-2 mb-3">
            {tags.map(t => (
              <span key={t.id} className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-gray-100 text-sm">
                {t.name}
                <button type="button" onClick={() => deleteTag(t.id)} className="text-red-600 hover:underline text-xs">×</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              placeholder="New tag name"
              className="flex-1 px-3 py-2 border rounded-lg text-sm"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createTag(); } }}
            />
            <button type="button" onClick={() => createTag()} className="px-4 py-2 bg-[#007f8f] text-white rounded-lg text-sm">Add</button>
          </div>
        </div>

        <div className="mb-6 p-4 bg-white rounded-xl shadow">
          <h3 className="font-semibold text-gray-800 mb-3">Import from PDF</h3>
          <p className="text-sm text-gray-600 mb-3">
            Upload a competition PDF (e.g. MathCounts, AMC). Problems are auto-extracted and placed in a folder. <strong>No AI mode</strong> (default): paste the answer key — no API key needed. <strong>Use AI</strong>: converts to LaTeX, auto-tags, can solve — requires <code className="bg-gray-100 px-1 rounded">GEMINI_API_KEY</code>.
          </p>
          <label className="flex items-center gap-2 mb-3 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={pdfImportUseAI}
              onChange={(e) => setPdfImportUseAI(e.target.checked)}
            />
            Use AI (LaTeX, auto-tags, optional solving) — requires API key
          </label>
          <div className="flex flex-wrap gap-3 items-end mb-3">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs text-gray-500 mb-1">PDF file</label>
              <input
                id="pdf-import-input"
                type="file"
                accept="application/pdf"
                onChange={(e) => setPdfImportFile(e.target.files?.[0] || null)}
                className="w-full text-sm text-gray-600"
              />
            </div>
            <button
              type="button"
              onClick={handlePdfImport}
              disabled={pdfImportLoading || !pdfImportFile}
              className="px-4 py-2 bg-[#007f8f] text-white rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pdfImportLoading ? 'Importing…' : 'Import'}
            </button>
          </div>
          <div className="mb-2">
            <label className="block text-xs text-gray-500 mb-1">Answer key (required — one per line) — format: 1. 42, 2. 3/4, 3. 90000</label>
            <textarea
              value={pdfImportAnswerKey}
              onChange={(e) => setPdfImportAnswerKey(e.target.value)}
              placeholder={'1. 101\n2. 90000\n3. 18'}
              className="w-full px-3 py-2 border rounded-lg text-sm font-mono min-h-[60px]"
              rows={3}
            />
          </div>
          {pdfImportResult && (
            <div className={`mt-3 p-3 rounded-lg text-sm ${pdfImportResult.error ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-800'}`}>
              {pdfImportResult.error ? (
                pdfImportResult.error
              ) : (
                <>
                  Imported {pdfImportResult.imported} problems into folder &quot;{pdfImportResult.folderName}&quot;.
                  {pdfImportResult.errors?.length > 0 && (
                    <div className="mt-2 text-amber-700">
                      {pdfImportResult.errors.length} problem(s) failed: {pdfImportResult.errors.slice(0, 3).join('; ')}
                      {pdfImportResult.errors.length > 3 && ` …`}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <button
          onClick={() => setEditingProblem({ question: '', answer: '', topic: '', image_url: '', source: '', folder_id: null, tag_ids: [] })}
          className="mb-6 bg-[#007f8f] text-white px-6 py-3 rounded-lg"
        >
          Add Problem
        </button>

        {editingProblem && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
              <h4 className="text-xl font-bold mb-4 text-center">
                {editingProblem.id ? 'Edit' : 'Add'} Problem
              </h4>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Question (LaTeX: $inline$ or $$display$$)</label>
                  <textarea
                    value={editingProblem.question}
                    onChange={(e) =>
                      setEditingProblem({ ...editingProblem, question: e.target.value })
                    }
                    className="w-full px-4 py-2 border rounded-lg min-h-[80px]"
                    placeholder="e.g. What is $x^2 + 1$ when $x = 2$?"
                    rows={3}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Image / screenshot (optional)</label>
                  {editingProblem.image_url ? (
                    <div className="flex items-start gap-2">
                      <img
                        src={API_URL + editingProblem.image_url}
                        alt="Problem"
                        className="max-h-32 rounded border object-contain bg-gray-50"
                      />
                      <button
                        type="button"
                        onClick={() => setEditingProblem({ ...editingProblem, image_url: '' })}
                        className="text-sm text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const formData = new FormData();
                        formData.append('image', file);
                        try {
                          const { data } = await api.post('/api/upload', formData, {
                            headers: { 'Content-Type': 'multipart/form-data' }
                          });
                          setEditingProblem({ ...editingProblem, image_url: data.url });
                        } catch (err) {
                          alert(err.response?.data?.error || 'Upload failed');
                        }
                        e.target.value = '';
                      }}
                      className="w-full text-sm text-gray-600"
                    />
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Answer (number, fraction, or radical)</label>
                  <input
                    type="text"
                    value={editingProblem.answer ?? ''}
                    onChange={(e) =>
                      setEditingProblem({ ...editingProblem, answer: e.target.value })
                    }
                    className="w-full px-4 py-2 border rounded-lg"
                    placeholder="e.g. 42, 3/4, √2, √2/2, 2√3"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Folder</label>
                  <select
                    value={editingProblem.folder_id ?? ''}
                    onChange={(e) =>
                      setEditingProblem({ ...editingProblem, folder_id: e.target.value ? Number(e.target.value) : null })
                    }
                    className="w-full px-4 py-2 border rounded-lg"
                  >
                    <option value="">Uncategorized</option>
                    {folders.map(f => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tags</label>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {tags.map(t => (
                      <label key={t.id} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-gray-200 bg-gray-50 text-sm cursor-pointer hover:bg-gray-100">
                        <input
                          type="checkbox"
                          checked={(editingProblem.tag_ids ?? []).includes(t.id)}
                          onChange={(e) => {
                            const ids = editingProblem.tag_ids ?? [];
                            setEditingProblem({
                              ...editingProblem,
                              tag_ids: e.target.checked
                                ? [...ids, t.id]
                                : ids.filter(id => id !== t.id)
                            });
                          }}
                        />
                        {t.name}
                      </label>
                    ))}
                  </div>
                  <div className="flex gap-2 mt-1">
                    <input
                      type="text"
                      placeholder="Add new tag"
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      className="flex-1 px-3 py-1.5 border rounded-lg text-sm"
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createTag(); } }}
                    />
                    <button type="button" onClick={() => createTag()} className="px-3 py-1.5 text-sm text-[#007f8f] hover:underline">Add</button>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Source (optional)</label>
                  <input
                    type="text"
                    value={editingProblem.source ?? ''}
                    onChange={(e) =>
                      setEditingProblem({ ...editingProblem, source: e.target.value })
                    }
                    className="w-full px-4 py-2 border rounded-lg"
                    placeholder="e.g. 2017 AMC 8, Contest Name"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveProblem}
                    className="flex-1 bg-[#007f8f] text-white py-2 rounded-lg"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingProblem(null)}
                    className="flex-1 bg-gray-200 py-2 rounded-lg"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {problemToDelete != null && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" role="dialog" aria-modal="true">
            <div className="bg-white rounded-xl p-6 max-w-sm w-full shadow-xl">
              <p className="text-gray-800 font-medium mb-4">Delete this problem?</p>
              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={() => setProblemToDelete(null)}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => confirmDeleteProblem(problemToDelete)}
                  className="px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700"
                >
                  Yes, delete
                </button>
              </div>
            </div>
          </div>
        )}

        {selectedProblemIds.length > 0 && (
          <div className="bg-[#007f8f]/10 border border-[#007f8f]/30 rounded-xl p-4 mb-4 flex flex-wrap items-center gap-3">
            <span className="font-medium text-gray-800">{selectedProblemIds.length} selected</span>
            <select
              value={bulkMoveFolderId}
              onChange={(e) => setBulkMoveFolderId(e.target.value)}
              className="px-3 py-1.5 border rounded-lg text-sm"
            >
              <option value="">Move to folder…</option>
              <option value="uncategorized">Uncategorized</option>
              {folders.map(f => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={bulkMoveProblems}
              disabled={!bulkMoveFolderId}
              className="px-3 py-1.5 bg-[#007f8f] text-white rounded-lg text-sm hover:bg-[#006b78] disabled:opacity-50"
            >
              Move
            </button>
            <button
              type="button"
              onClick={bulkDeleteProblems}
              className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700"
            >
              Delete selected
            </button>
            <button
              type="button"
              onClick={() => setSelectedProblemIds([])}
              className="text-gray-600 hover:underline text-sm"
            >
              Clear selection
            </button>
          </div>
        )}

        <div className="space-y-4">
          {(() => {
            const UNCategorized = 'uncategorized';
            const byFolder = {};
            for (const f of folders) {
              byFolder[f.id] = { name: f.name, problems: [] };
            }
            byFolder[UNCategorized] = { name: 'Uncategorized', problems: [] };
            for (const p of problems) {
              const fid = p.folder_id ?? UNCategorized;
              if (!byFolder[fid]) byFolder[fid] = { name: p.folder_name || 'Uncategorized', problems: [] };
              byFolder[fid].problems.push(p);
            }
            const folderIds = [...folders].sort((a, b) => a.name.localeCompare(b.name)).map(f => f.id);
            const orderedFolders = [
              ...folderIds,
              ...(byFolder[UNCategorized]?.problems?.length ? [UNCategorized] : [])
            ];
            if (orderedFolders.length === 0 && problems.length === 0) {
              return (
                <div className="bg-white rounded-xl shadow p-8 text-center text-gray-500">
                  No folders or problems yet. Add a folder above or import from PDF.
                </div>
              );
            }
            return orderedFolders.map(fid => {
              const { name, problems: folderProbs } = byFolder[fid] || { name: 'Uncategorized', problems: [] };
              const expandKey = fid === UNCategorized ? -1 : fid;
              const isExpanded = adminExpandedFolders.has(expandKey);
              const toggle = () => setAdminExpandedFolders(prev => {
                const next = new Set(prev);
                if (next.has(expandKey)) next.delete(expandKey);
                else next.add(expandKey);
                return next;
              });
              return (
                <div key={fid} className="bg-white rounded-xl shadow overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
                    <button
                      type="button"
                      onClick={toggle}
                      className="flex items-center gap-2 text-left font-semibold text-gray-800 hover:text-[#007f8f]"
                    >
                      <span className="text-gray-400">{isExpanded ? '▼' : '▶'}</span>
                      <span>{name}</span>
                      <span className="text-sm font-normal text-gray-500">({folderProbs.length} problems)</span>
                    </button>
                    {fid !== UNCategorized && (
                      <button
                        type="button"
                        onClick={() => deleteFolder(fid)}
                        className="text-red-600 hover:underline text-sm font-medium"
                      >
                        Delete folder
                      </button>
                    )}
                  </div>
                  {isExpanded && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-left">
                          <tr>
                            <th className="px-4 py-3 w-10">
                              <input
                                type="checkbox"
                                checked={folderProbs.length > 0 && folderProbs.every(p => selectedProblemIds.includes(p.id))}
                                ref={el => {
                                  if (el) {
                                    const some = folderProbs.some(p => selectedProblemIds.includes(p.id));
                                    el.indeterminate = some && !folderProbs.every(p => selectedProblemIds.includes(p.id));
                                  }
                                }}
                                onChange={(e) => {
                                  const ids = folderProbs.map(p => p.id);
                                  setSelectedProblemIds(prev =>
                                    e.target.checked ? [...new Set([...prev, ...ids])] : prev.filter(id => !ids.includes(id))
                                  );
                                }}
                                className="rounded"
                                onClick={ev => ev.stopPropagation()}
                              />
                            </th>
                            <th className="px-4 py-3">Question</th>
                            <th className="px-4 py-3">Answer</th>
                            <th className="px-4 py-3">Tags</th>
                            <th className="px-4 py-3">Source</th>
                            <th className="px-4 py-3">ELO</th>
                            <th className="px-4 py-3">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {folderProbs.map(p => (
                            <tr key={p.id} className="border-t">
                              <td className="px-4 py-3">
                                <input
                                  type="checkbox"
                                  checked={selectedProblemIds.includes(p.id)}
                                  onChange={(e) =>
                                    setSelectedProblemIds(prev =>
                                      e.target.checked ? [...prev, p.id] : prev.filter(id => id !== p.id)
                                    )
                                  }
                                  className="rounded"
                                  onClick={ev => ev.stopPropagation()}
                                />
                              </td>
                              <td className="px-4 py-3 max-w-md">
                                <div>
                                  <RenderLatex text={p.question} />
                                  {p.image_url && (
                                    <ProblemImage url={p.image_url} token={token} />
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3">{p.answer}</td>
                              <td className="px-4 py-3">{p.tag_names?.length ? p.tag_names.join(', ') : '—'}</td>
                              <td className="px-4 py-3">{p.source ?? '—'}</td>
                              <td className="px-4 py-3">{p.elo}</td>
                              <td className="px-4 py-3 space-x-2">
                                <button
                                  type="button"
                                  onClick={() => setEditingProblem({ ...p, image_url: p.image_url ?? '', source: p.source ?? '', folder_id: p.folder_id ?? null, tag_ids: p.tag_ids ?? [] })}
                                  className="text-[#007f8f] hover:underline font-medium"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setProblemToDelete(p.id)}
                                  className="text-red-600 hover:underline font-medium"
                                >
                                  Delete
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
      </div>
    </div>
  );
}


return (
  <div className="min-h-screen bg-[#f5f7f8] flex items-center justify-center text-gray-500">
    Loading…
  </div>
);

};

export default App;
