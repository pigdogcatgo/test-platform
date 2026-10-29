import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { API_URL } from './config';
import ProblemImage from './components/ProblemImage';
import StudentTestPage from './components/StudentTestPage';
import { AuthLayout, PasswordField } from './components/AuthLayout';
import AccessibleDialog from './components/AccessibleDialog';
import ConfirmationDialog from './components/ConfirmationDialog';
import LatexRenderer from './components/LatexRenderer';
import './index.css';

const App = () => {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [user, setUser] = useState(null);
  const [view, setView] = useState(() => localStorage.getItem('token') ? 'loading' : 'login');
  const [sessionError, setSessionError] = useState(null);
  const [dashboardLoadError, setDashboardLoadError] = useState(null);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [signupForm, setSignupForm] = useState({ username: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  
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
  const [testDeadlineAt, setTestDeadlineAt] = useState(null);
  const [startingTestId, setStartingTestId] = useState(null);
  const testSubmitRef = useRef({ activeTest: null, testAnswers: {}, testProblems: [] });
  const handleSubmitTestRef = useRef(() => {});
  
  const [editingProblem, setEditingProblem] = useState(null);
  const [problemToDelete, setProblemToDelete] = useState(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingFolderId, setEditingFolderId] = useState(null);
  const [editingFolderName, setEditingFolderName] = useState('');
  const [expandedFolders, setExpandedFolders] = useState(() => new Set()); // folder names (create-test)
  const [adminExpandedFolders, setAdminExpandedFolders] = useState(() => new Set()); // folder IDs expanded in admin (empty = all collapsed)
  const [pdfImportFile, setPdfImportFile] = useState(null);
  const [pdfImportAnswerKey, setPdfImportAnswerKey] = useState('');
  const [pdfImportLoading, setPdfImportLoading] = useState(false);
  const [pdfImportResult, setPdfImportResult] = useState(null);
  const [pdfImportUseAI, setPdfImportUseAI] = useState(true);
  const [pdfImportUseImageMode, setPdfImportUseImageMode] = useState(false);
  const [pdfImportRunVerification, setPdfImportRunVerification] = useState(true);
  const [pdfImportReview, setPdfImportReview] = useState(null);
  const [newTest, setNewTest] = useState({ name: '', problemIds: [], dueDate: '', timeLimit: 30, testType: 'sprint' });
  const [createTestError, setCreateTestError] = useState('');
  const [newStudent, setNewStudent] = useState({ username: '', password: '' });
  const [selectedTestAnalytics, setSelectedTestAnalytics] = useState(null);
  const [analyticsSolutionsLink, setAnalyticsSolutionsLink] = useState('');
  const [analyticsAnswersReleased, setAnalyticsAnswersReleased] = useState(false);
  const [selectedProblemIds, setSelectedProblemIds] = useState([]);
  const [problemSearch, setProblemSearch] = useState('');
  const [bulkMoveFolderId, setBulkMoveFolderId] = useState('');
  const [selectedStudentId, setSelectedStudentId] = useState(null);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [leaderboardSortBy, setLeaderboardSortBy] = useState('cumulative'); // 'cumulative' | 'elo'
  const [attemptDetails, setAttemptDetails] = useState(null);
  const [submittingTest, setSubmittingTest] = useState(false);
  const [submissionError, setSubmissionError] = useState('');
  const [submissionNotice, setSubmissionNotice] = useState('');
  const [testExpirationNotice, setTestExpirationNotice] = useState('');
  const submissionInProgressRef = useRef(false);

  const clearDashboardData = useCallback(() => {
    setProblems([]);
    setFolders([]);
    setTags([]);
    setTests([]);
    setAttempts([]);
    setStudents([]);
    setSelectedStudentId(null);
    setSelectedStudent(null);
    setProblemSearch('');
    setSelectedTestAnalytics(null);
    setAttemptDetails(null);
  }, []);

  // Create axios instance with useMemo with useMemo to prevent recreation on every render
  const api = useMemo(() => {
    return axios.create({
      baseURL: API_URL,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
  }, [token]);

  const handleLogout = useCallback((message) => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    setLoginForm({ username: '', password: '' });
    setSignupForm({ username: '', password: '' });
    setShowPassword(false);
    setShowSignupPassword(false);
    setAuthBusy(false);
    setAuthError(typeof message === 'string' ? message : '');
    setSubmissionError('');
    clearDashboardData();
    setSessionError(null);
    setDashboardLoadError(null);
    setView('login');
    setActiveTest(null);
    setTestDeadlineAt(null);
    setTestExpirationNotice('');
    setStartingTestId(null);
    for (const key of Object.keys(sessionStorage)) {
      if (key === 'testInProgress' || key.startsWith('testAnswers_')) {
        sessionStorage.removeItem(key);
      }
    }
  }, [clearDashboardData]);

  const loadUserData = useCallback(async (opts = {}) => {
    const preserveView = opts.preserveView ?? false;
    const requestToken = token;
    setDashboardLoadError(null);

    let userData;
    try {
      const response = await api.get('/api/me');
      userData = response.data;
    } catch (error) {
      // Ignore a late response from a session that has since been replaced or logged out.
      if (localStorage.getItem('token') !== requestToken) return;
      const status = error.response?.status;
      if (status === 401) {
        handleLogout();
        return;
      }
      console.error('Error validating session:', error);
      setSessionError('We could not verify your session right now. Your sign-in is saved; try again.');
      setView('session-error');
      return;
    }

    if (localStorage.getItem('token') !== requestToken) return;
    setSessionError(null);
    setUser(userData);
    if (!preserveView) {
      if (userData.role === 'student') {
        setView('student-dashboard');
      } else if (userData.role === 'teacher') {
        setView('teacher-dashboard');
      } else if (userData.role === 'admin') {
        setView('admin-dashboard');
      } else {
        handleLogout();
        return;
      }
    }

    try {
      if (userData.role === 'student') {
        const [testsRes, attemptsRes] = await Promise.all([
          api.get('/api/tests'),
          api.get('/api/attempts')
        ]);
        if (localStorage.getItem('token') !== requestToken) return;
        setTests(testsRes.data);
        setAttempts(attemptsRes.data);
      } else if (userData.role === 'teacher') {
        const [problemsRes, testsRes, studentsRes, foldersRes, tagsRes] = await Promise.all([
          api.get('/api/problems'),
          api.get('/api/tests'),
          api.get('/api/students'),
          api.get('/api/folders'),
          api.get('/api/tags')
        ]);
        if (localStorage.getItem('token') !== requestToken) return;
        setProblems(problemsRes.data);
        setTests(testsRes.data);
        setStudents(studentsRes.data);
        setFolders(foldersRes.data);
        setTags(tagsRes.data);
      } else if (userData.role === 'admin') {
        const [problemsRes, foldersRes, tagsRes] = await Promise.all([
          api.get('/api/problems'),
          api.get('/api/folders'),
          api.get('/api/tags')
        ]);
        if (localStorage.getItem('token') !== requestToken) return;
        setProblems(problemsRes.data);
        setFolders(foldersRes.data);
        setTags(tagsRes.data);
      }
    } catch (error) {
      if (localStorage.getItem('token') !== requestToken) return;
      if (error.response?.status === 401) {
        handleLogout();
        return;
      }
      console.error('Error loading dashboard data:', error);
      setDashboardLoadError('You are signed in, but some dashboard information could not be loaded. Retry, or contact the site administrator if this continues.');
    }
  }, [api, handleLogout, token]);

  const handleExpiredTest = useCallback((testId) => {
    sessionStorage.removeItem('testInProgress');
    sessionStorage.removeItem('testAnswers_' + testId);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    setActiveTest(null);
    setTestProblems([]);
    setTestAnswers({});
    setTimeRemaining(null);
    setTestDeadlineAt(null);
    setSubmissionError('');
    setTestExpirationNotice('The time limit for this test has passed, so it was closed without recording an attempt. Ask your teacher to assign a new test if you need another try.');
    setView('student-dashboard');
    loadUserData({ preserveView: true }).catch(() => {});
  }, [loadUserData]);

  const handleSubmitTest = useCallback(async () => {
    if (!activeTest || submissionInProgressRef.current) return;
    submissionInProgressRef.current = true;
    setSubmittingTest(true);
    setSubmissionError('');
    const payload = {};
    for (const p of testProblems) {
      payload[p.id] = (testAnswers[p.id] ?? '').trim();
    }
    try {
      const { data } = await api.post(`/api/tests/${activeTest.id}/submit`, { answers: payload });
      const testId = activeTest.id;
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      sessionStorage.removeItem('testInProgress');
      sessionStorage.removeItem('testAnswers_' + testId);
      setActiveTest(null);
      setTestProblems([]);
      setTestAnswers({});
      setTimeRemaining(null);
      setTestDeadlineAt(null);
      setView('student-dashboard');
      loadUserData().catch(() => {});
      setSubmissionNotice(`Test submitted. Score: ${data.attempt.score}/${data.attempt.total}. ELO change: ${data.eloChange >= 0 ? '+' : ''}${data.eloChange}.`);
    } catch (error) {
      if (error.response?.status === 401) {
        handleLogout('Your session expired before the test was submitted. Sign in again; this attempt was not recorded.');
        return;
      }
      if (error.response?.status === 410) {
        handleExpiredTest(activeTest.id);
        return;
      }
      setSubmissionError(error.response?.data?.error || 'Could not submit your answers. Check your connection and try again.');
    } finally {
      submissionInProgressRef.current = false;
      setSubmittingTest(false);
    }
  }, [activeTest, testAnswers, testProblems, api, loadUserData, handleLogout, handleExpiredTest]);

  handleSubmitTestRef.current = handleSubmitTest;

  // The server provides remaining time; performance.now keeps the countdown immune to wall-clock changes.
  useEffect(() => {
    if (!activeTest || timeRemaining === null || testDeadlineAt === null) return;
    if (timeRemaining <= 0) {
      handleSubmitTest();
      return;
    }
    const computeRemaining = () => Math.max(0, Math.ceil((testDeadlineAt - performance.now()) / 1000));
    const next = computeRemaining();
    if (next <= 0) {
      handleSubmitTest();
      return;
    }
    const timer = setTimeout(() => setTimeRemaining(computeRemaining()), 1000);
    return () => clearTimeout(timer);
  }, [timeRemaining, activeTest, testDeadlineAt, handleSubmitTest]);

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
    const { testId, problemIds = [] } = data;
    const test = tests.find(t => t.id === testId);
    if (!test) return;
    const requestToken = token;
    let cancelled = false;
    (async () => {
      try {
        const { data: session } = await api.post(`/api/tests/${testId}/start`);
        if (cancelled || !requestToken || localStorage.getItem('token') !== requestToken) return;
        const { data: probs } = await api.get(`/api/tests/${testId}/problems`);
        if (cancelled || !requestToken || localStorage.getItem('token') !== requestToken) return;
        const ordered = problemIds.map(id => probs.find(p => p.id === id)).filter(Boolean);
        const savedAnswers = sessionStorage.getItem('testAnswers_' + testId);
        const answers = savedAnswers ? JSON.parse(savedAnswers) : {};
        setActiveTest(test);
        setTestProblems(ordered.length ? ordered : probs);
        setTestAnswers(answers);
        const remainingMs = Math.max(0, Number(session.remainingMs) || 0);
        setTestDeadlineAt(performance.now() + remainingMs);
        setTimeRemaining(Math.ceil(remainingMs / 1000));
        setView('taking-test');
      } catch (error) {
        if (cancelled) return;
        if (error.response?.status === 401) handleLogout('Your session expired. Sign in again to continue.');
        else if (error.response?.status === 410) {
          handleExpiredTest(testId);
        }
        else console.error('Could not restore the active test:', error);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.role, tests, api, view, activeTest, token, handleLogout, loadUserData, handleExpiredTest]);

  // Keep ref updated so beforeunload can submit with latest answers
  useEffect(() => {
    if (view === 'taking-test' && activeTest) {
      testSubmitRef.current = { activeTest, testAnswers, testProblems };
    }
  }, [view, activeTest, testAnswers, testProblems]);

  // Lockdown: auto-submit on leave / tab switch
  useEffect(() => {
    if (view !== 'taking-test' || !activeTest) return;
    let leftWhileHidden = false;
    const onBeforeUnload = (e) => {
      const { activeTest: at, testAnswers: ta, testProblems: tp } = testSubmitRef.current;
      if (at && ta) {
        const payload = {};
        for (const p of tp || []) {
          payload[p.id] = (ta[p.id] ?? '').trim();
        }
        if (Object.keys(payload).length > 0 || Object.keys(ta).length > 0) {
          const t = localStorage.getItem('token');
          if (t) {
            const body = Object.keys(payload).length > 0 ? payload : ta;
            fetch(`${API_URL}/api/tests/${at.id}/submit`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
              body: JSON.stringify({ answers: body }),
              keepalive: true
            });
          }
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

  // Load student profile when viewing student-profile
  useEffect(() => {
    if (view === 'student-profile' && selectedStudentId && user?.role === 'teacher') {
      setSelectedStudent(null);
      api.get(`/api/students/${selectedStudentId}`)
        .then(({ data }) => setSelectedStudent(data))
        .catch(() => {
          alert('Error loading student profile');
          setView('teacher-dashboard');
          setSelectedStudentId(null);
        });
    }
  }, [view, selectedStudentId, user?.role, api]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthBusy(true);
    try {
      const { data } = await axios.post(`${API_URL}/api/login`, loginForm);
      clearDashboardData();
      setLoginForm({ username: '', password: '' });
      setShowPassword(false);
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
      setSessionError(null);
      setDashboardLoadError(null);
      setView('loading');
    } catch (error) {
      const msg = error.response?.data?.error || (error.response?.status === 401 ? 'Invalid credentials' : (error.message || 'Login failed'));
      setAuthError(msg);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthBusy(true);
    if (!signupForm.username.trim() || !signupForm.password) {
      setAuthError('Enter a username and password to continue.');
      setAuthBusy(false);
      return;
    }
    if (Array.from(signupForm.password).length < 12) {
      setAuthError('Choose a password with at least 12 characters.');
      setAuthBusy(false);
      return;
    }
    if (new TextEncoder().encode(signupForm.password).length > 72) {
      setAuthError('That password is too long. Use no more than 72 UTF-8 bytes.');
      setAuthBusy(false);
      return;
    }
    try {
      const { data } = await axios.post(`${API_URL}/api/signup`, signupForm);
      clearDashboardData();
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
      setSessionError(null);
      setDashboardLoadError(null);
      setView('loading');
      setSignupForm({ username: '', password: '' });
      setLoginForm({ username: '', password: '' });
      setShowPassword(false);
    } catch (error) {
      setAuthError(error.response?.data?.error || 'Signup failed. Please try again.');
    } finally {
      setAuthBusy(false);
    }
  };

  const startTest = async (test) => {
    if (startingTestId !== null) return;
    const hasAttempt = attempts.find(a => a.test_id === test.id);
    if (hasAttempt) {
      alert('You have already completed this test');
      return;
    }

    setStartingTestId(test.id);
    const requestToken = token;
    try {
      const { data: session } = await api.post(`/api/tests/${test.id}/start`);
      if (!requestToken || localStorage.getItem('token') !== requestToken) return;
      const { data: testProbs } = await api.get(`/api/tests/${test.id}/problems`);
      if (!requestToken || localStorage.getItem('token') !== requestToken) return;
      const folderIds = [...new Set(testProbs.map(p => p.folder_id ?? 'uncategorized'))];
      const allSameFolder = folderIds.length <= 1;
      const ordered = allSameFolder ? testProbs : [...testProbs].sort(() => Math.random() - 0.5);
      sessionStorage.setItem('testInProgress', JSON.stringify({
        testId: test.id,
        problemIds: ordered.map(p => p.id)
      }));
      sessionStorage.removeItem('testAnswers_' + test.id);
      
      setActiveTest(test);
      setTestProblems(ordered);
      const remainingMs = Math.max(0, Number(session.remainingMs) || 0);
      setTestDeadlineAt(performance.now() + remainingMs);
      setTimeRemaining(Math.ceil(remainingMs / 1000));
      setTestAnswers({});
      setView('taking-test');
      try {
        document.documentElement.requestFullscreen?.();
      } catch {
        // Fullscreen optional; user may deny
      }
    } catch (error) {
      if (localStorage.getItem('token') !== requestToken) return;
      if (error.response?.status === 401) {
        handleLogout('Your session expired. Sign in again to continue.');
        return;
      }
      if (error.response?.status === 410) {
        handleExpiredTest(test.id);
        return;
      }
      alert(error.response?.data?.error || 'Could not load this test. Please try again.');
    } finally {
      setStartingTestId(null);
    }
  };

  const createTest = async () => {
    const expectedProblemCount = newTest.testType === 'target' ? 8 : 30;
    if (!newTest.name.trim() || !newTest.dueDate) {
      setCreateTestError('Add a test name and due date to continue.');
      return;
    }
    if (newTest.problemIds.length !== expectedProblemCount) {
      setCreateTestError(`${newTest.testType === 'target' ? 'Target' : 'Sprint'} tests need exactly ${expectedProblemCount} problems. Select ${expectedProblemCount - newTest.problemIds.length} more.`);
      return;
    }

    setCreateTestError('');
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
      setView('teacher-dashboard');
    } catch (error) {
      setCreateTestError(error.response?.data?.error || 'Could not create the test. Please try again.');
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
      alert('Please enter an answer (e.g. 42, 3/4, √2, or "Saturday", "(-1,-3)" for strings/ordered pairs).');
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
      loadUserData({ preserveView: true });
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
      loadUserData({ preserveView: true });
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
      loadUserData({ preserveView: true });
    } catch (error) {
      alert(error.response?.data?.error || 'Error moving problems');
    }
  };

  const bulkDeleteProblems = async () => {
    if (selectedProblemIds.length === 0) return;
    const search = problemSearch.trim().toLocaleLowerCase();
    const visibleIds = new Set(problems.filter(problem => {
      const searchable = `${problem.question || ''} ${problem.source || ''} ${problem.topic || ''} ${problem.folder_name || ''}`.toLocaleLowerCase();
      return !search || searchable.includes(search);
    }).map(problem => problem.id));
    const hiddenCount = selectedProblemIds.filter(id => !visibleIds.has(id)).length;
    const hiddenMessage = hiddenCount ? ` ${hiddenCount} selected problem${hiddenCount === 1 ? ' is' : 's are'} hidden by the current search and will also be deleted.` : '';
    if (!confirm(`Delete all ${selectedProblemIds.length} selected problem(s)?${hiddenMessage}`)) return;
    try {
      await api.delete('/api/problems/bulk', { data: { ids: selectedProblemIds } });
      setSelectedProblemIds([]);
      loadUserData({ preserveView: true });
    } catch (error) {
      alert(error.response?.data?.error || 'Error deleting problems');
    }
  };

  const createFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      await api.post('/api/folders', { name: newFolderName.trim() });
      setNewFolderName('');
      loadUserData({ preserveView: true });
    } catch (error) {
      alert(error.response?.data?.error || 'Error creating folder');
    }
  };

  const deleteFolder = async (id) => {
    if (!confirm('Delete this folder? Problems will move to Uncategorized.')) return;
    try {
      await api.delete(`/api/folders/${id}`);
      setAdminExpandedFolders(prev => { const next = new Set(prev); next.delete(id); return next; });
      loadUserData({ preserveView: true });
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
      loadUserData({ preserveView: true });
    } catch (error) {
      alert(error.response?.data?.error || 'Error updating folder');
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
    setPdfImportReview(null);
    try {
      if (pdfImportUseImageMode) {
        const formData = new FormData();
        formData.append('pdf', pdfImportFile);
        formData.append('answerKey', pdfImportAnswerKey.trim());
        const { data } = await api.post('/api/import-pdf/start', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          timeout: 300000,
        });
        setPdfImportReview(data);
        setPdfImportFile(null);
        setPdfImportAnswerKey('');
        const input = document.getElementById('pdf-import-input');
        if (input) input.value = '';
      } else {
        const formData = new FormData();
        formData.append('pdf', pdfImportFile);
        formData.append('answerKey', pdfImportAnswerKey.trim());
        formData.append('useAI', (user?.role === 'teacher' ? true : pdfImportUseAI) ? 'true' : 'false');
        formData.append('useImageMode', 'false');
        formData.append('runVerification', pdfImportRunVerification ? 'true' : 'false');
        const { data } = await api.post('/api/import-pdf', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          timeout: 300000,
        });
        setPdfImportResult(data);
        setPdfImportFile(null);
        setPdfImportAnswerKey('');
        const input = document.getElementById('pdf-import-input');
        if (input) input.value = '';
        loadUserData({ preserveView: true });
      }
    } catch (error) {
      setPdfImportResult({ error: error.response?.data?.error || error.message || 'Import failed' });
    } finally {
      setPdfImportLoading(false);
    }
  };

  const handlePdfImportConfirm = async (accepted, direction = null) => {
    if (!pdfImportReview?.importId) return;
    setPdfImportLoading(true);
    try {
      const body = { importId: pdfImportReview.importId, accepted };
      if (!accepted && direction) body.direction = direction;
      const { data } = await api.post('/api/import-pdf/confirm', body);
      if (data.done) {
        setPdfImportResult(data);
        setPdfImportReview(null);
        loadUserData({ preserveView: true });
      } else {
        setPdfImportReview((prev) => ({ ...prev, ...data }));
      }
    } catch (error) {
      setPdfImportResult({ error: error.response?.data?.error || error.message || 'Confirm failed' });
    } finally {
      setPdfImportLoading(false);
    }
  };

  const loadTestAnalytics = async (testId) => {
    try {
      const { data } = await api.get(`/api/tests/${testId}/attempts`);
      setSelectedTestAnalytics({ testId, attempts: data });
      const t = tests.find(x => x.id === testId);
      if (t) {
        setAnalyticsSolutionsLink(t.solutions_link ?? '');
        setAnalyticsAnswersReleased(t.answers_released ?? false);
      }
    } catch (error) {
      alert(error.response?.data?.error || 'Could not load analytics. Please try again.');
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

if (view === 'session-error') {
  return (
    <div className="min-h-screen bg-[#f5f7f8] flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl bg-white p-6 text-center shadow">
        <h1 className="mb-2 text-xl font-semibold text-gray-800">Session check unavailable</h1>
        <p className="mb-5 text-sm text-gray-600">{sessionError}</p>
        <div className="flex justify-center gap-3">
          <button type="button" onClick={() => loadUserData()} className="rounded-lg bg-[#006da6] px-4 py-2 text-sm font-medium text-white">Retry</button>
          <button type="button" onClick={handleLogout} className="rounded-lg border px-4 py-2 text-sm text-gray-700">Log out</button>
        </div>
      </div>
    </div>
  );
}

if (view === 'login') {
  return (
    <AuthLayout>
      <div className="auth-card">
        <p className="auth-kicker">Welcome back</p>
        <h1>Sign in to your team</h1>
        <p className="auth-subtitle">Continue to your MATHCOUNTS practice space.</p>
        {authError && <div className="auth-alert" role="alert">{authError}</div>}
        <form onSubmit={handleLogin} className="auth-form">
          <div className="auth-field">
            <label htmlFor="login-username">Username</label>
            <input id="login-username" name="username" type="text" autoComplete="username" value={loginForm.username} onChange={e => setLoginForm({ ...loginForm, username: e.target.value })} required />
          </div>
          <PasswordField id="login-password" value={loginForm.password} onChange={e => setLoginForm({ ...loginForm, password: e.target.value })} autoComplete="current-password" visible={showPassword} onToggle={() => setShowPassword(value => !value)} />
          <button type="submit" className="auth-primary-button" disabled={authBusy}>{authBusy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className="auth-switch">New teacher? <button type="button" onClick={() => { setAuthError(''); setView('signup'); }}>Create an account</button></p>
      </div>
    </AuthLayout>
  );
}

if (view === 'signup') {
  return (
    <AuthLayout>
      <div className="auth-card">
        <p className="auth-kicker">Teacher access</p>
        <h1>Create your account</h1>
        <p className="auth-subtitle">Set up a space for your team and practice sessions.</p>
        {authError && <div className="auth-alert" role="alert">{authError}</div>}
        <form onSubmit={handleSignup} className="auth-form">
          <div className="auth-field">
            <label htmlFor="signup-username">Username</label>
            <input id="signup-username" name="username" type="text" autoComplete="username" value={signupForm.username} onChange={e => setSignupForm({ ...signupForm, username: e.target.value })} required />
          </div>
          <PasswordField id="signup-password" value={signupForm.password} onChange={e => setSignupForm({ ...signupForm, password: e.target.value })} autoComplete="new-password" visible={showSignupPassword} onToggle={() => setShowSignupPassword(value => !value)} minLength={12} hint="Use at least 12 characters. A longer passphrase is easier to remember and harder to guess." />
          <button type="submit" className="auth-primary-button" disabled={authBusy}>{authBusy ? 'Creating account…' : 'Create teacher account'}</button>
        </form>
        <p className="auth-switch">Already have an account? <button type="button" onClick={() => { setAuthError(''); setView('login'); }}>Sign in</button></p>
      </div>
    </AuthLayout>
  );
}

if (view === 'taking-test' && activeTest) {
  return (
    <StudentTestPage
      activeTest={activeTest}
      timeRemaining={timeRemaining}
      testProblems={testProblems}
      testAnswers={testAnswers}
      setTestAnswers={setTestAnswers}
      token={token}
      onSubmit={handleSubmitTest}
      submitting={submittingTest}
      submissionError={submissionError}
      onOpenReview={() => setSubmissionError('')}
    />
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
              className="text-sm text-[#006da6] font-medium hover:underline"
            >
              Logout
            </button>
          </div>
        </div>

        {dashboardLoadError && (
          <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <span>{dashboardLoadError}</span>
            <button type="button" onClick={() => loadUserData({ preserveView: true })} className="font-semibold underline">Retry loading</button>
          </div>
        )}

        {submissionNotice && (
          <div role="status" className="mb-6 rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-medium text-green-900">{submissionNotice}</div>
        )}
        {testExpirationNotice && (
          <div role="status" className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-950">{testExpirationNotice}</div>
        )}

        {/* Welcome Card */}
        <div className="bg-white rounded-xl shadow p-6 mb-6 text-center">
          <h2 className="text-2xl font-semibold text-gray-800 mb-1">
            Welcome, {user.username}
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            Here’s a snapshot of your progress
          </p>

          <div className="flex flex-wrap gap-4 justify-center">
            <div className="inline-flex flex-col items-center bg-[#e8f4f9] px-6 py-4 rounded-xl" title="Skill rating based on problem difficulty and correctness; increases when you solve harder problems correctly, decreases when you miss easier ones">
              <span className="text-xs text-gray-600 mb-1">Overall ELO</span>
              <span className="text-4xl font-bold text-[#006da6]">
                {user.elo}
              </span>
            </div>
            {typeof user.cumulative_score === 'number' && (
              <div className="inline-flex flex-col items-center bg-white border border-gray-200 px-6 py-4 rounded-xl" title="Sprint problems correct + 2× target problems correct">
                <span className="text-xs text-gray-600 mb-1">Cumulative Score</span>
                <span className="text-4xl font-bold text-[#006da6]">
                  {user.cumulative_score}
                </span>
              </div>
            )}
            {user.tag_elos?.length > 0 && (
              <div className="inline-flex flex-col items-start bg-white border border-gray-200 px-4 py-3 rounded-xl">
                <span className="text-xs text-gray-600 mb-2">By Subject</span>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {user.tag_elos.map(t => (
                    <span key={t.name} className="text-gray-800">
                      {t.name}: <span className="font-semibold text-[#006da6]">{t.elo}</span>
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
                    <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                      This test submits automatically if you switch to another tab or app. Keep it open in the foreground until you finish.
                    </p>
                    <button
                      type="button"
                      onClick={() => startTest(test)}
                      disabled={startingTestId !== null || test.session_expired}
                      aria-busy={startingTestId === test.id}
                      className="w-full bg-[#006da6] hover:bg-[#006699] disabled:cursor-not-allowed disabled:opacity-70 text-white py-2 rounded-lg text-sm font-medium"
                    >
                      {startingTestId === test.id ? 'Preparing test…' : test.session_expired ? 'Time expired' : 'Start Test'}
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
            <p className="text-sm text-gray-500 mb-3">
              Click View Details to see your answers and the solutions link (when your teacher releases them).
            </p>

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
                      <button
                        onClick={async () => {
                          try {
                            const { data } = await api.get(`/api/attempts/${attempt.id}/details`);
                            setAttemptDetails(data);
                          } catch {
                            alert('Error loading attempt details');
                          }
                        }}
                        className="mt-2 text-sm text-[#006da6] font-medium hover:underline"
                      >
                        View Details
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Attempt Details Modal */}
        {attemptDetails && (
          <AccessibleDialog ariaLabel="Test results" onClose={() => setAttemptDetails(null)} panelClassName="max-w-2xl p-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold text-gray-800">Test Results</h3>
                <button type="button" aria-label="Close test results" onClick={() => setAttemptDetails(null)} className="text-gray-500 hover:text-gray-700 text-2xl leading-none">&times;</button>
              </div>
              <p className="text-sm text-gray-600 mb-4">
                Score: {attemptDetails.attempt.score}/{attemptDetails.attempt.total}
                {attemptDetails.attempt.elo_after != null && (
                  <span className="ml-2">ELO: {attemptDetails.attempt.elo_before} → {attemptDetails.attempt.elo_after}</span>
                )}
              </p>
              {attemptDetails.showAnswers && attemptDetails.problems?.length > 0 ? (
                <div className="space-y-4">
                  {attemptDetails.solutionsLink && (
                    <div className="mb-4 p-3 bg-[#e8f4f9] rounded-lg border border-[#006da6]/30">
                      <span className="text-sm font-medium text-gray-700">Solutions: </span>
                      <a href={attemptDetails.solutionsLink} target="_blank" rel="noopener noreferrer" className="text-[#006da6] hover:underline font-medium">
                        View solutions →
                      </a>
                    </div>
                  )}
                  {attemptDetails.problems.map((item, idx) => (
                    <div key={item.problem_id} className={`border rounded-lg p-4 ${item.correct ? 'border-green-200 bg-green-50/50' : 'border-red-200 bg-red-50/50'}`}>
                      <p className="text-xs text-gray-500 mb-1">Question {idx + 1}</p>
                      <div className="text-sm text-gray-800 mb-2"><LatexRenderer text={item.question} /></div>
                      {item.image_url && <ProblemImage url={item.image_url} token={token} />}
                      <p className="text-sm mt-2">
                        <span className="font-medium">Your answer:</span> {String(item.student_answer || '(blank)')}
                        {item.correct ? (
                          <span className="text-green-600 ml-2">✓ Correct</span>
                        ) : (
                          <>
                            <span className="text-red-600 ml-2">✗ Incorrect</span>
                            <span className="block mt-1 text-[#006da6]"><span className="font-medium">Correct answer:</span> {String(item.correct_answer ?? '')}</span>
                          </>
                        )}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500">
                  {attemptDetails.showAnswers ? 'No problem details available.' : 'Answers and the solutions link will appear here when your teacher releases them.'}
                </p>
              )}
          </AccessibleDialog>
        )}
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
            className="text-sm text-[#006da6] font-medium hover:underline"
          >
            Logout
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {dashboardLoadError && (
          <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <span>{dashboardLoadError}</span>
            <button type="button" onClick={() => loadUserData({ preserveView: true })} className="font-semibold underline">Retry loading</button>
          </div>
        )}
        <div className="mb-6 flex gap-3">
          <button
            onClick={() => setView('register-students')}
            className="bg-[#006da6] hover:bg-[#006699] text-white px-6 py-3 rounded-lg font-medium"
          >
            Register Students
          </button>
          <button
            onClick={() => setView('create-test')}
            className="bg-[#006da6] hover:bg-[#006699] text-white px-6 py-3 rounded-lg font-medium"
          >
            Create New Test
          </button>
          <button
            onClick={() => setView('teacher-admin')}
            className="bg-gray-700 hover:bg-gray-800 text-white px-6 py-3 rounded-lg font-medium"
          >
            Team Problem Bank
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
                      className="text-sm text-[#006da6] font-medium hover:underline"
                    >
                      View Analytics →
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Student leaderboard */}
          <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-800">
              Student Leaderboard
            </h2>
            <div className="flex flex-wrap items-center gap-4 mb-3">
              <p className="text-sm text-gray-500">
                Click a name to view their profile. Only students you register can see your tests.
              </p>
              <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
                <span className="text-sm text-gray-600">Rank by:</span>
                <select
                  value={leaderboardSortBy}
                  onChange={(e) => setLeaderboardSortBy(e.target.value)}
                  className="text-sm border border-gray-200 rounded px-2 py-1 bg-white"
                >
                  <option value="cumulative">Cumulative score</option>
                  <option value="elo">ELO</option>
                </select>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow divide-y">
              {students.length === 0 ? (
                <div className="p-6 text-center text-gray-500 text-sm">
                  No students yet. <button type="button" onClick={() => setView('register-students')} className="text-[#006da6] font-medium hover:underline">Register students</button> to get started.
                </div>
              ) : (
                [...students]
                  .sort((a, b) => {
                    if (leaderboardSortBy === 'elo') {
                      return (b.elo ?? 0) - (a.elo ?? 0);
                    }
                    return (b.cumulative_score ?? 0) - (a.cumulative_score ?? 0);
                  })
                  .map((s, i) => (
                    <div key={s.id} className="p-4">
                      <div className="flex justify-between items-center">
                        <button
                          type="button"
                          onClick={() => { setSelectedStudentId(s.id); setView('student-profile'); }}
                          className="font-medium text-left hover:text-[#006da6] hover:underline"
                        >
                          {i + 1}. {s.username}
                        </button>
                        <div className="flex gap-4">
                          {typeof s.cumulative_score === 'number' && (
                            <span className="text-gray-600" title="Sprint problems correct + 2× target problems correct">
                              Cumulative: <span className="font-semibold text-[#006da6]">{s.cumulative_score}</span>
                            </span>
                          )}
                          <span className="text-[#006da6] font-semibold" title="Skill rating based on problem difficulty and correctness">
                            ELO: {s.elo}
                          </span>
                        </div>
                      </div>
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
    id: a.id,
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
            type="button"
            onClick={() => setView('teacher-dashboard')}
            className="text-sm text-[#006da6] hover:underline"
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
            <h2 className="text-base font-semibold text-gray-800 mb-4">Test Settings</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Solutions link (shown to students when answers are released)</label>
                <input
                  type="url"
                  value={analyticsSolutionsLink}
                  onChange={(e) => setAnalyticsSolutionsLink(e.target.value)}
                  placeholder="https://..."
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={analyticsAnswersReleased}
                  onChange={(e) => setAnalyticsAnswersReleased(e.target.checked)}
                />
                <span className="text-sm">Release answers to students (they can see correct answers and solutions link)</span>
              </label>
              <button
                onClick={async () => {
                  try {
                    await api.put(`/api/tests/${test?.id}`, {
                      solutions_link: analyticsSolutionsLink,
                      answers_released: analyticsAnswersReleased
                    });
                    const t = tests.find(x => x.id === test?.id);
                    if (t) {
                      t.solutions_link = analyticsSolutionsLink;
                      t.answers_released = analyticsAnswersReleased;
                    }
                    alert('Settings saved');
                  } catch (err) {
                    alert(err.response?.data?.error || 'Failed to save');
                  }
                }}
                className="px-4 py-2 bg-[#006da6] text-white rounded-lg text-sm font-medium hover:bg-[#006699]"
              >
                Save settings
              </button>
            </div>
          </div>

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
                      <th className="pb-2 pr-4">Accuracy</th>
                      <th className="pb-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {studentAccuracies.map((s, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-2 pr-4 font-medium">{s.username}</td>
                        <td className="py-2 pr-4">{s.score}/{s.total}</td>
                        <td className="py-2 pr-4">{s.accuracy}%</td>
                        <td className="py-2">
                          <button
                            onClick={async () => {
                              try {
                                const { data } = await api.get(`/api/attempts/${s.id}/details`);
                                setAttemptDetails(data);
                              } catch {
                                alert('Error loading submission');
                              }
                            }}
                            className="text-sm text-[#006da6] font-medium hover:underline"
                          >
                            View submission
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {attemptDetails && (
            <AccessibleDialog ariaLabel="Student test submission" onClose={() => setAttemptDetails(null)} panelClassName="max-w-2xl p-6">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold text-gray-800">
                    Submission — {studentAccuracies.find(s => s.id === attemptDetails.attempt?.id)?.username || 'Student'}
                  </h3>
                  <button type="button" aria-label="Close student test submission" onClick={() => setAttemptDetails(null)} className="text-gray-500 hover:text-gray-700 text-2xl leading-none">&times;</button>
                </div>
                <p className="text-sm text-gray-600 mb-4">
                  Score: {attemptDetails.attempt?.score}/{attemptDetails.attempt?.total}
                  {attemptDetails.attempt?.elo_after != null && (
                    <span className="ml-2">ELO: {attemptDetails.attempt.elo_before} → {attemptDetails.attempt.elo_after}</span>
                  )}
                </p>
                {attemptDetails.showAnswers && attemptDetails.problems?.length > 0 ? (
                  <div className="space-y-4">
                    {attemptDetails.solutionsLink && (
                      <div className="mb-4 p-3 bg-[#e8f4f9] rounded-lg border border-[#006da6]/30">
                        <span className="text-sm font-medium text-gray-700">Solutions: </span>
                        <a href={attemptDetails.solutionsLink} target="_blank" rel="noopener noreferrer" className="text-[#006da6] hover:underline font-medium">
                          View solutions →
                        </a>
                      </div>
                    )}
                    {attemptDetails.problems.map((item, idx) => (
                      <div key={item.problem_id} className={`border rounded-lg p-4 ${item.correct ? 'border-green-200 bg-green-50/50' : 'border-red-200 bg-red-50/50'}`}>
                        <p className="text-xs text-gray-500 mb-1">Question {idx + 1}</p>
                        <div className="text-sm text-gray-800 mb-2"><LatexRenderer text={item.question} /></div>
                        {item.image_url && <ProblemImage url={item.image_url} token={token} />}
                        <p className="text-sm mt-2">
                          <span className="font-medium">Answer:</span> {String(item.student_answer || '(blank)')}
                          {item.correct ? (
                            <span className="text-green-600 ml-2">✓ Correct</span>
                          ) : (
                            <>
                              <span className="text-red-600 ml-2">✗ Incorrect</span>
                              <span className="block mt-1 text-[#006da6]"><span className="font-medium">Correct:</span> {String(item.correct_answer ?? '')}</span>
                            </>
                          )}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">
                    {attemptDetails.showAnswers ? 'No problem details available.' : 'Full submission details visible to teacher.'}
                  </p>
                )}
            </AccessibleDialog>
          )}

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
            className="text-sm text-[#006da6] hover:underline"
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
              className="bg-[#006da6] hover:bg-[#006699] text-white px-5 py-2 rounded-lg font-medium"
            >
              Add student
            </button>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow">
          <h2 className="text-base font-semibold text-gray-800 p-4 pb-2">My students</h2>
          <div className="flex flex-wrap items-center gap-4 px-4 pb-4">
            <p className="text-sm text-gray-500">
              Only these students can see and take your tests.
            </p>
            <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2">
              <span className="text-sm text-gray-600">Rank by:</span>
              <select
                value={leaderboardSortBy}
                onChange={(e) => setLeaderboardSortBy(e.target.value)}
                className="text-sm border border-gray-200 rounded px-2 py-1 bg-white"
              >
                <option value="cumulative">Cumulative score</option>
                <option value="elo">ELO</option>
              </select>
            </div>
          </div>
          <div className="divide-y">
            {students.length === 0 ? (
              <div className="p-6 text-center text-gray-500 text-sm">
                No students yet. Add one above.
              </div>
            ) : (
              [...students]
                .sort((a, b) => {
                  if (leaderboardSortBy === 'elo') {
                    return (b.elo ?? 0) - (a.elo ?? 0);
                  }
                  return (b.cumulative_score ?? 0) - (a.cumulative_score ?? 0);
                })
                .map((s, i) => (
                  <div key={s.id} className="p-4">
                    <div className="flex justify-between items-center">
                      <button
                        type="button"
                        onClick={() => { setSelectedStudentId(s.id); setView('student-profile'); }}
                        className="font-medium text-left hover:text-[#006da6] hover:underline"
                      >
                        {i + 1}. {s.username}
                      </button>
                      <div className="flex gap-4">
                        {typeof s.cumulative_score === 'number' && (
                          <span className="text-gray-600" title="Sprint problems correct + 2× target problems correct">
                            Cumulative: <span className="font-semibold text-[#006da6]">{s.cumulative_score}</span>
                          </span>
                        )}
                        <span className="text-[#006da6] font-semibold" title="Skill rating based on problem difficulty and correctness">
                          ELO: {s.elo}
                        </span>
                      </div>
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

if (view === 'student-profile' && user) {
  if (!selectedStudent) {
    return (
      <div className="min-h-screen bg-[#f5f7f8] flex items-center justify-center">
        <p className="text-gray-500">Loading student profile...</p>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-4xl p-6">
        <div className="bg-white rounded-xl shadow p-6 mb-6 flex justify-between items-center">
          <button
            onClick={() => { setView('teacher-dashboard'); setSelectedStudentId(null); setSelectedStudent(null); }}
            className="text-sm text-[#006da6] hover:underline"
          >
            ← Back to Dashboard
          </button>
          <h1 className="text-lg font-semibold text-gray-800">
            Student Profile: {selectedStudent.username}
          </h1>
          <span />
        </div>

        <div className="bg-white rounded-xl shadow p-6 mb-6">
          <h2 className="text-base font-semibold text-gray-800 mb-4">Ratings</h2>
          <div className="flex flex-wrap gap-4">
            <div className="inline-flex flex-col items-center bg-[#e8f4f9] px-6 py-4 rounded-xl" title="Skill rating based on problem difficulty and correctness; increases when solving harder problems correctly, decreases when missing easier ones">
              <span className="text-xs text-gray-600 mb-1">Overall ELO</span>
              <span className="text-2xl font-bold text-[#006da6]">{selectedStudent.elo}</span>
            </div>
            <div className="inline-flex flex-col items-center bg-white border border-gray-200 px-6 py-4 rounded-xl" title="Sprint problems correct + 2× target problems correct">
              <span className="text-xs text-gray-600 mb-1">Cumulative Score</span>
              <span className="text-2xl font-bold text-[#006da6]">{selectedStudent.cumulative_score ?? 0}</span>
            </div>
            {selectedStudent.tag_elos?.length > 0 && (
              <div className="inline-flex flex-col items-start bg-white border border-gray-200 px-4 py-3 rounded-xl">
                <span className="text-xs text-gray-600 mb-2">By Subject</span>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {selectedStudent.tag_elos.map(t => (
                    <span key={t.name}>{t.name}: <span className="font-semibold text-[#006da6]">{t.elo}</span></span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-4">Recent Problem History</h2>
          {!selectedStudent.problem_history?.length ? (
            <p className="text-gray-500 text-sm">No problems attempted yet.</p>
          ) : (
            <div className="space-y-4 max-h-[500px] overflow-y-auto">
              {selectedStudent.problem_history.map((item, idx) => (
                <div key={`${item.problem_id}-${item.completed_at}-${idx}`} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-500 mb-1">{item.test_name} • {new Date(item.completed_at).toLocaleDateString()}</p>
                      <div className="text-sm text-gray-800">
                        <LatexRenderer text={item.question} />
                      </div>
                      {item.image_url && (
                        <div className="mt-2">
                          <ProblemImage url={item.image_url} token={token} />
                        </div>
                      )}
                      {!item.correct && item.student_answer != null && (
                        <p className="text-sm mt-2 text-red-600">
                          Your answer: <span className="font-medium">{String(item.student_answer)}</span>
                        </p>
                      )}
                    </div>
                    <span className={`flex-shrink-0 px-2 py-1 rounded text-xs font-medium ${item.correct ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                      {item.correct ? 'Correct' : 'Incorrect'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
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
            className="text-sm text-[#006da6] hover:underline"
          >
            ← Back
          </button>
          <h1 className="text-lg font-semibold text-gray-800">
            Create New Test
          </h1>
          <span />
        </div>

        <form onSubmit={event => { event.preventDefault(); createTest(); }} className="bg-white rounded-xl shadow p-5 sm:p-8 space-y-6">
          <div>
            <label htmlFor="new-test-name" className="mb-2 block text-sm font-medium text-gray-700">Test name</label>
            <input
              id="new-test-name"
              maxLength={200}
              required
              className="w-full border rounded-lg px-4 py-3"
              placeholder="For example, October practice"
              value={newTest.name}
              onChange={(e) => { setNewTest({ ...newTest, name: e.target.value }); setCreateTestError(''); }}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="new-test-due-date" className="mb-2 block text-sm font-medium text-gray-700">Due date</label>
            <input
              id="new-test-due-date"
              type="date"
              required
              className="w-full border rounded-lg px-4 py-3"
              value={newTest.dueDate}
              onChange={(e) => { setNewTest({ ...newTest, dueDate: e.target.value }); setCreateTestError(''); }}
            />
            </div>
            <div>
              <label htmlFor="new-test-time-limit" className="mb-2 block text-sm font-medium text-gray-700">Time limit (minutes)</label>
            <input
              id="new-test-time-limit"
              type="number"
              min={1}
              max={240}
              step={1}
              required
              className="w-full border rounded-lg px-4 py-3"
              value={newTest.timeLimit}
              onChange={(e) => setNewTest({ ...newTest, timeLimit: e.target.value === '' ? '' : Number(e.target.value) })}
            />
            </div>
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-gray-700">Test type</legend>
            <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
              <label className="flex flex-1 items-start gap-3 rounded-lg border border-gray-200 p-4 cursor-pointer">
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
              <label className="flex flex-1 items-start gap-3 rounded-lg border border-gray-200 p-4 cursor-pointer">
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
          </fieldset>

          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-gray-800">Choose problems</h2>
            <p className="text-sm text-gray-600" role="status" aria-live="polite">{newTest.problemIds.length} selected · {newTest.testType === 'target' ? '8' : '30'} required</p>
          </div>
          <div className="max-h-96 overflow-y-auto border rounded-lg p-4 space-y-1" role="region" aria-label="Problem selection">
            {(() => {
              const byFolder = {};
              for (const p of problems) {
                const fname = p.folder_name || 'Uncategorized';
                if (!byFolder[fname]) byFolder[fname] = [];
                byFolder[fname].push(p);
              }
              const folderNames = Object.keys(byFolder).sort();
              return folderNames.map((fname, folderIndex) => {
                const isExpanded = expandedFolders.has(fname);
                const folderPanelId = `folder-problems-${folderIndex}`;
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
                        aria-label={`Select all problems in ${fname}`}
                        className="flex-shrink-0 mr-2"
                      />
                      <button
                        type="button"
                        onClick={toggle}
                        aria-expanded={isExpanded}
                        aria-controls={folderPanelId}
                        className="flex-1 flex items-center justify-between text-left font-semibold text-gray-700 text-sm"
                      >
                        <span>{fname}</span>
                        <span className="text-gray-400" aria-hidden="true">{isExpanded ? '▼' : '▶'}</span>
                      </button>
                    </div>
                    <div id={folderPanelId} hidden={!isExpanded} className="border-t border-gray-200 p-3 space-y-2">
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
                              <span className="text-[#006da6] font-medium ml-2">ELO {p.elo}</span>
                            </span>
                          </label>
                        ))}
                    </div>
                  </div>
                );
              });
            })()}
          </div>

          {createTestError && <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{createTestError}</p>}
          <button
            type="submit"
            disabled={newTest.problemIds.length !== (newTest.testType === 'target' ? 8 : 30) || !newTest.name.trim() || !newTest.dueDate || !Number.isInteger(Number(newTest.timeLimit)) || Number(newTest.timeLimit) < 1 || Number(newTest.timeLimit) > 240}
            className="w-full bg-[#006da6] hover:bg-[#006699] disabled:cursor-not-allowed disabled:opacity-50 text-white py-3 rounded-lg font-medium"
          >
            Create Test
          </button>
        </form>
      </div>
    </div>
  );
}

if ((view === 'admin-dashboard' || view === 'teacher-admin') && user) {
  const isTeacherAdmin = user.role === 'teacher';
  const normalizedProblemSearch = problemSearch.trim().toLocaleLowerCase();
  const visibleProblemIds = new Set(problems
    .filter(problem => {
      const searchable = `${problem.question || ''} ${problem.source || ''} ${problem.topic || ''} ${problem.folder_name || ''}`.toLocaleLowerCase();
      return !normalizedProblemSearch || searchable.includes(normalizedProblemSearch);
    })
    .map(problem => problem.id));
  const hiddenSelectedCount = selectedProblemIds.filter(id => !visibleProblemIds.has(id)).length;
  return (
    <div className="min-h-screen bg-[#f5f7f8] flex justify-center">
      <div className="w-full max-w-6xl p-6">
        <div className="bg-white rounded-xl shadow p-4 mb-6 flex justify-between">
          <h1 className="font-semibold text-gray-800">
            {isTeacherAdmin ? 'Team Problem Bank' : 'Admin Portal'}
          </h1>
          <div className="flex gap-4">
            {isTeacherAdmin && (
              <button
                onClick={() => setView('teacher-dashboard')}
                className="text-sm text-[#006da6] hover:underline"
              >
                ← Back to Dashboard
              </button>
            )}
            <button
              onClick={handleLogout}
              className="text-sm text-[#006da6] hover:underline"
            >
              Logout
            </button>
          </div>
        </div>

        {dashboardLoadError && (
          <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <span>{dashboardLoadError}</span>
            <button type="button" onClick={() => loadUserData({ preserveView: true })} className="font-semibold underline">Retry loading</button>
          </div>
        )}

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
                    <button type="button" onClick={() => updateFolder(f.id)} className="text-[#006da6] hover:underline text-xs">✓</button>
                    <button type="button" onClick={() => { setEditingFolderId(null); setEditingFolderName(''); }} className="text-gray-500 hover:underline text-xs">✗</button>
                  </>
                ) : (
                  <>
                    {f.name}
                    <button type="button" onClick={() => { setEditingFolderId(f.id); setEditingFolderName(f.name); }} className="text-[#006da6] hover:underline text-xs">edit</button>
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
            <button type="button" onClick={createFolder} className="px-4 py-2 bg-[#006da6] text-white rounded-lg text-sm">Add</button>
          </div>
        </div>

        <div className="mb-6 p-4 bg-white rounded-xl shadow">
          <h3 className="font-semibold text-gray-800 mb-3">Tags</h3>
          <p className="text-sm text-gray-500 mb-2">Algebra, Arithmetic, Counting, Geometry, Number Theory, Probability (system tags — cannot be edited)</p>
          <div className="flex flex-wrap gap-2">
            {tags.map(t => (
              <span key={t.id} className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-gray-100 text-sm">
                {t.name}
              </span>
            ))}
          </div>
        </div>

        <div className="mb-6 p-4 bg-white rounded-xl shadow">
          <h3 className="font-semibold text-gray-800 mb-3">Import from PDF</h3>
          {isTeacherAdmin && (
            <p className="text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded mb-3">
              Problems you import are for your team only. Public problems (from Admin) are available to all teachers.
            </p>
          )}
          <p className="text-sm text-gray-600 mb-3">
            Upload a PDF of problems and enter an answer key. AI is used to auto-extract problems, sort them, and place them in a separate folder.
            {user?.role === 'teacher' ? (
              <span> AI processing must be enabled by your site administrator before you can import a PDF.</span>
            ) : (
              <span> <strong>Use AI</strong> converts questions to LaTeX and adds topic tags. It requires AI processing to be enabled on the server.</span>
            )}
          </p>
          {user?.role !== 'teacher' && (
            <label className="flex items-center gap-2 mb-3 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={pdfImportUseAI}
                onChange={(e) => setPdfImportUseAI(e.target.checked)}
              />
              Use AI to format questions and add topic tags
            </label>
          )}
          <label className="flex items-center gap-2 mb-3 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={pdfImportUseImageMode}
              onChange={(e) => setPdfImportUseImageMode(e.target.checked)}
            />
            Use problem images (screenshot each problem from PDF instead of LaTeX — preserves exact appearance)
          </label>
          <label className={`flex items-center gap-2 mb-3 text-sm cursor-pointer ${pdfImportUseImageMode ? 'opacity-60' : ''}`}>
            <input
              type="checkbox"
              checked={pdfImportRunVerification}
              onChange={(e) => setPdfImportRunVerification(e.target.checked)}
              disabled={pdfImportUseImageMode}
            />
            Run verification pass (second AI pass to catch LaTeX transcription errors)
            {pdfImportUseImageMode && <span className="text-gray-500">— skipped in image mode</span>}
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
              className="px-4 py-2 bg-[#006da6] text-white rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pdfImportLoading ? 'Importing…' : 'Import'}
            </button>
          </div>
          <div className="mb-2">
            <label className="block text-xs text-gray-500 mb-1">Answer key (required — one per line). Use quotes for strings/ordered pairs: 1. 42, 2. 3/4, 3. &quot;Saturday&quot;, 4. &quot;(-1,-3)&quot;</label>
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

          {pdfImportReview && (
            <AccessibleDialog ariaLabel={`Review problem ${pdfImportReview.problemNumber} image`} panelClassName="max-w-2xl p-6" closeOnBackdrop={false} closeOnEscape={false}>
                <h4 className="text-lg font-bold mb-2">
                  Problem {pdfImportReview.problemNumber} of {pdfImportReview.total}
                </h4>
                <p className="text-sm text-gray-600 mb-4">
                  Does this screenshot contain the right problem?
                </p>
                {pdfImportReview.screenshot ? (
                  <img
                    key={`${pdfImportReview.problemIndex}-${pdfImportReview.reviewVersion ?? 0}`}
                    src={pdfImportReview.screenshot}
                    alt={`Problem ${pdfImportReview.problemNumber}`}
                    className="w-full border rounded-lg mb-4 max-h-[50vh] object-contain bg-gray-50"
                  />
                ) : (
                  <div className="w-full h-48 border rounded-lg mb-4 bg-gray-100 flex items-center justify-center text-gray-500">
                    No preview available
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => handlePdfImportConfirm(true)}
                    disabled={pdfImportLoading}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                  >
                    {pdfImportLoading ? '…' : 'Yes, correct'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePdfImportConfirm(false, 'up')}
                    disabled={pdfImportLoading}
                    className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                    title="Region should move up (include more from above)"
                  >
                    {pdfImportLoading ? '…' : 'No — move up'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePdfImportConfirm(false, 'down')}
                    disabled={pdfImportLoading}
                    className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                    title="Region should move down (include more from below)"
                  >
                    {pdfImportLoading ? '…' : 'No — move down'}
                  </button>
                </div>
            </AccessibleDialog>
          )}
        </div>

        <button
          onClick={() => setEditingProblem({ question: '', answer: '', topic: '', image_url: '', source: '', folder_id: null, tag_ids: [] })}
          className="mb-6 bg-[#006da6] text-white px-6 py-3 rounded-lg"
        >
          Add Problem
        </button>

        {editingProblem && (
          <AccessibleDialog ariaLabel={editingProblem.id ? 'Edit problem' : 'Add problem'} onClose={() => setEditingProblem(null)} panelClassName="max-w-lg p-6">
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
                    className="flex-1 bg-[#006da6] text-white py-2 rounded-lg"
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
          </AccessibleDialog>
        )}

        {problemToDelete != null && (
          <AccessibleDialog ariaLabel="Delete problem confirmation" onClose={() => setProblemToDelete(null)} panelClassName="max-w-sm p-6">
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
          </AccessibleDialog>
        )}

        <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <label htmlFor="problem-bank-search" className="mb-2 block text-sm font-semibold text-gray-800">Search problems</label>
          <input
            id="problem-bank-search"
            type="search"
            value={problemSearch}
            onChange={event => setProblemSearch(event.target.value)}
            placeholder="Search question text, source, topic, or folder"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#006da6] focus:outline-none"
          />
          {normalizedProblemSearch && <p className="mt-2 text-xs text-gray-600">Showing matches for “{problemSearch.trim()}”.</p>}
        </div>

        {selectedProblemIds.length > 0 && (
          <div className="bg-[#006da6]/10 border border-[#006da6]/30 rounded-xl p-4 mb-4 flex flex-wrap items-center gap-3">
            <span className="font-medium text-gray-800">{selectedProblemIds.length} selected</span>
            {hiddenSelectedCount > 0 && <span role="status" className="text-sm text-gray-700">{hiddenSelectedCount} selected problem{hiddenSelectedCount === 1 ? ' is' : 's are'} hidden by this search; bulk actions still include {hiddenSelectedCount} hidden item{hiddenSelectedCount === 1 ? '' : 's'}.</span>}
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
              className="px-3 py-1.5 bg-[#006da6] text-white rounded-lg text-sm hover:bg-[#006699] disabled:opacity-50"
            >
              Move
            </button>
            <button
              type="button"
              onClick={bulkDeleteProblems}
              className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700"
            >
              Delete all selected
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
              const searchable = `${p.question || ''} ${p.source || ''} ${p.topic || ''} ${p.folder_name || ''}`.toLocaleLowerCase();
              if (normalizedProblemSearch && !searchable.includes(normalizedProblemSearch)) continue;
              const fid = p.folder_id ?? UNCategorized;
              if (!byFolder[fid]) byFolder[fid] = { name: p.folder_name || 'Uncategorized', problems: [] };
              byFolder[fid].problems.push(p);
            }
            const folderIds = [...folders].sort((a, b) => a.name.localeCompare(b.name)).map(f => f.id);
            const orderedFolders = [
              ...folderIds,
              ...(byFolder[UNCategorized]?.problems?.length ? [UNCategorized] : [])
            ].filter(id => !normalizedProblemSearch || byFolder[id]?.problems?.length > 0);
            if (orderedFolders.length === 0 && normalizedProblemSearch) {
              return <div role="status" className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-600">No problems match “{problemSearch.trim()}”.</div>;
            }
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
              const folderPanelId = `problem-folder-panel-${expandKey}`;
              const isExpanded = normalizedProblemSearch ? folderProbs.length > 0 : adminExpandedFolders.has(expandKey);
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
                      disabled={Boolean(normalizedProblemSearch)}
                      aria-expanded={isExpanded}
                      aria-controls={folderPanelId}
                      className="flex items-center gap-2 text-left font-semibold text-gray-800 hover:text-[#006da6] disabled:cursor-default disabled:hover:text-gray-800"
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
                  <div id={folderPanelId} hidden={!isExpanded} className="overflow-x-auto">
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
                                  <LatexRenderer text={p.question} />
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
                                  className="text-[#006da6] hover:underline font-medium"
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
