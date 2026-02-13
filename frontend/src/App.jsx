import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { API_URL } from './config';
import './index.css';
import 'katex/dist/katex.min.css';
import { InlineMath, BlockMath } from 'react-katex';

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
  const [newTest, setNewTest] = useState({ name: '', problemIds: [], dueDate: '', timeLimit: 30 });
  const [newStudent, setNewStudent] = useState({ username: '', password: '' });
  const [selectedTestAnalytics, setSelectedTestAnalytics] = useState(null);

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
        const [problemsRes, testsRes, studentsRes] = await Promise.all([
          api.get('/api/problems'),
          api.get('/api/tests'),
          api.get('/api/students')
        ]);
        setProblems(problemsRes.data);
        setTests(testsRes.data);
        setStudents(studentsRes.data);
      } else if (userData.role === 'admin') {
        setView('admin-dashboard');
        const { data: problemsData } = await api.get('/api/problems');
        setProblems(problemsData);
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

  const RenderLatex = ({ text }) => {
    if (!text) return null;
    
    const parts = [];
    let lastIndex = 0;
    
    // Match both inline $...$ and display $$...$$ LaTeX
    const regex = /\$\$(.+?)\$\$|\$(.+?)\$/g;
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      // Add text before the match
      if (match.index > lastIndex) {
        parts.push(text.substring(lastIndex, match.index));
      }
      
      // Add the LaTeX part
      if (match[1]) {
        // Display math $$...$$
        parts.push(<BlockMath key={match.index} math={match[1]} />);
      } else if (match[2]) {
        // Inline math $...$
        parts.push(<InlineMath key={match.index} math={match[2]} />);
      }
      
      lastIndex = regex.lastIndex;
    }
    
    // Add remaining text
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
        timeLimit: newTest.timeLimit
      });
      setNewTest({ name: '', problemIds: [], dueDate: '', timeLimit: 30 });
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
      source: (editingProblem.source ?? '').trim() || null
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

          <div className="inline-flex flex-col items-center bg-[#e6f6f7] px-6 py-4 rounded-xl">
            <span className="text-xs text-gray-600 mb-1">Your ELO</span>
            <span className="text-4xl font-bold text-[#007f8f]">
              {user.elo}
            </span>
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
                      onClick={() => loadTestAnalytics(test.id)}
                      className="text-sm text-[#007f8f] font-medium hover:underline"
                    >
                      View Analytics →
                    </button>

                    {selectedTestAnalytics?.testId === test.id && (
                      <div className="mt-4 pt-4 border-t text-sm">
                        {selectedTestAnalytics.attempts.slice(0, 5).map((a, i) => (
                          <div key={a.id} className="flex justify-between mb-1">
                            <span>{i + 1}. {a.username}</span>
                            <span className="font-medium">{a.score}/{a.total}</span>
                          </div>
                        ))}
                      </div>
                    )}
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
                  <div key={s.id} className="flex justify-between p-4">
                    <span className="font-medium">{i + 1}. {s.username}</span>
                    <span className="text-[#007f8f] font-semibold">{s.elo}</span>
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
                <div key={s.id} className="flex justify-between p-4">
                  <span className="font-medium">{i + 1}. {s.username}</span>
                  <span className="text-[#007f8f] font-semibold">{s.elo}</span>
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

          <div className="max-h-64 overflow-y-auto border rounded-lg p-4 space-y-2">
            {problems.map(p => (
              <label key={p.id} className="flex gap-2 text-sm items-start">
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
                  className="mt-1"
                />
                <span className="flex-1 min-w-0">
                  <RenderLatex text={p.question} />
                  {p.image_url && (
                    <img
                      src={API_URL + p.image_url}
                      alt=""
                      className="mt-1 max-h-16 rounded border object-contain"
                    />
                  )}
                </span>
              </label>
            ))}
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

        <button
          onClick={() => setEditingProblem({ question: '', answer: '', topic: '', image_url: '', source: '' })}
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Topic (optional)</label>
                  <input
                    type="text"
                    value={editingProblem.topic ?? ''}
                    onChange={(e) =>
                      setEditingProblem({ ...editingProblem, topic: e.target.value })
                    }
                    className="w-full px-4 py-2 border rounded-lg"
                    placeholder="e.g. Algebra, Geometry"
                  />
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

        <div className="bg-white rounded-xl shadow overflow-x-auto"></div>

        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3">Question</th>
                <th className="px-4 py-3">Answer</th>
                <th className="px-4 py-3">Topic</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">ELO</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {problems.map(p => (
                <tr key={p.id} className="border-t">
                  <td className="px-4 py-3 max-w-md">
                    <div>
                      <RenderLatex text={p.question} />
                      {p.image_url && (
                        <img
                          src={API_URL + p.image_url}
                          alt=""
                          className="mt-2 max-h-20 rounded border object-contain"
                        />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">{p.answer}</td>
                  <td className="px-4 py-3">{p.topic}</td>
                  <td className="px-4 py-3">{p.source ?? '—'}</td>
                  <td className="px-4 py-3">{p.elo}</td>
                  <td className="px-4 py-3 space-x-2">
                    <button
                      type="button"
                      onClick={() => setEditingProblem({ ...p, image_url: p.image_url ?? '', source: p.source ?? '' })}
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
