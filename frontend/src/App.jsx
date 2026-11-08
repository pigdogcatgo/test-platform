import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { API_URL } from './config';
import ProblemImage from './components/ProblemImage';
import StudentTestPage from './components/StudentTestPage';
import { AuthLayout, PasswordField } from './components/AuthLayout';
import AccessibleDialog from './components/AccessibleDialog';
import ConfirmationDialog from './components/ConfirmationDialog';
import LatexRenderer from './components/LatexRenderer';
import DemoBanner from './components/DemoBanner';
import ProblemCatalogFilters from './components/ProblemCatalogFilters';
import ProblemDetailPage from './components/ProblemDetailPage';
import PrototypeInsights from './components/PrototypeInsights';
import { PracticeHeader, FolioIntro } from './components/PracticeLayout';
import './index.css';

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';
const DEMO_TEACHER_USERNAME = import.meta.env.VITE_DEMO_TEACHER_USERNAME || 'demo-teacher';
const DEMO_STUDENT_USERNAME = import.meta.env.VITE_DEMO_STUDENT_USERNAME || 'demo-student';
const DEMO_TEACHER_PASSWORD = import.meta.env.VITE_DEMO_TEACHER_PASSWORD || 'teacher-preview-26';
const DEMO_STUDENT_PASSWORD = import.meta.env.VITE_DEMO_STUDENT_PASSWORD || 'student-preview-26';
const EMPTY_CATALOG_FILTERS = { search: '', year: '', level: '', round: '' };
function getCatalogMetadata(problem, demoMode) {
  const source = typeof problem.source === 'string' ? problem.source : '';
  const sourceText = `${source} ${problem.folder_name || ''}`;
  const inferredYear = Number(sourceText.match(/\b(19\d{2}|20\d{2})\b/)?.[1]) || null;
  const inferredLevel = /\bnationals?\b/i.test(sourceText) ? 'Nationals' : /\bstate\b/i.test(sourceText) ? 'State' : /\bchapter\b/i.test(sourceText) ? 'Chapter' : /\bschool\b/i.test(sourceText) ? 'School' : '';
  const inferredRound = sourceText.match(/\b(Sprint|Target|Team|Countdown|Warm-Up|Warm Up)\s+Round\b/i)?.[1] || '';
  const inferredNumber = sourceText.match(/\bproblem\s*#?\s*(\d+)\b/i)?.[1] || '';
  const year = problem.year ?? (demoMode && inferredYear == null ? 2018 + (Math.abs(Number(problem.id) || 0) % 8) : inferredYear);
  const level = problem.level || inferredLevel;
  const round = problem.round || inferredRound;
  return {
    year: year == null ? '' : String(year),
    level: level || '',
    round: round || '',
    number: problem.problem_number ?? inferredNumber,
    elo: problem.elo == null ? '—' : String(problem.elo),
    group: [year, level].filter(Boolean).join(' ') || 'Source details needed',
  };
}

function getCatalogOptions(problems, demoMode) {
  const metadata = problems.map(problem => getCatalogMetadata(problem, demoMode));
  return {
    years: [...new Set(metadata.map(item => item.year).filter(Boolean))].sort((a, b) => Number(b) - Number(a)),
    levels: [...new Set(metadata.map(item => item.level).filter(Boolean))].sort(),
    rounds: [...new Set(metadata.map(item => item.round).filter(Boolean))].sort(),
  };
}

function filterCatalogProblems(problems, filters, demoMode) {
  const query = filters.search.trim().toLocaleLowerCase();
  return problems.filter(problem => {
    const metadata = getCatalogMetadata(problem, demoMode);
    const searchable = `${problem.question || ''} ${problem.source || ''} ${problem.folder_name || ''} ${metadata.year} ${metadata.level} ${metadata.round} ${metadata.number} ${metadata.elo}`.toLocaleLowerCase();
    if (query && !searchable.includes(query)) return false;
    if (filters.year && metadata.year !== filters.year) return false;
    if (filters.level && metadata.level !== filters.level) return false;
    if (filters.round && metadata.round !== filters.round) return false;
    return true;
  });
}

const App = () => {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [user, setUser] = useState(null);
  const [activeProblemId, setActiveProblemId] = useState(null);
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
  const [expandedFolders, setExpandedFolders] = useState(() => new Set()); // folder names (create-test)
  const [adminExpandedFolders, setAdminExpandedFolders] = useState(() => new Set()); // folder IDs expanded in admin (empty = all collapsed)
  const [newTest, setNewTest] = useState({ name: '', problemIds: [], dueDate: '', timeLimit: 30, testType: 'sprint' });
  const [testSelectionMode, setTestSelectionMode] = useState('manual');
  const [randomCriteria, setRandomCriteria] = useState({ count: '8', minElo: '', maxElo: '', year: '', level: '', round: '' });
  const [createTestError, setCreateTestError] = useState('');
  const [newStudent, setNewStudent] = useState({ username: '', password: '' });
  const [selectedTestAnalytics, setSelectedTestAnalytics] = useState(null);
  const [analyticsSolutionsLink, setAnalyticsSolutionsLink] = useState('');
  const [analyticsAnswersReleased, setAnalyticsAnswersReleased] = useState(false);
  const [selectedProblemIds, setSelectedProblemIds] = useState([]);
  const [catalogFilters, setCatalogFilters] = useState(EMPTY_CATALOG_FILTERS);
  const [studentClassEloVisible, setStudentClassEloVisible] = useState(true);
  const [teacherSettingsLoading, setTeacherSettingsLoading] = useState(true);
  const [teacherSettingsSaving, setTeacherSettingsSaving] = useState(false);
  const [teacherSettingsError, setTeacherSettingsError] = useState('');
  const [classElo, setClassElo] = useState(null);
  const [classEloStatus, setClassEloStatus] = useState('idle');
  const [classEloError, setClassEloError] = useState('');
  const [selectedStudentId, setSelectedStudentId] = useState(null);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [studentRemovalOpen, setStudentRemovalOpen] = useState(false);
  const [studentRemovalBusy, setStudentRemovalBusy] = useState(false);
  const [studentRemovalError, setStudentRemovalError] = useState('');
  const [accountReturnView, setAccountReturnView] = useState('teacher-dashboard');
  const [accountForm, setAccountForm] = useState({ username: '', currentPassword: '', newPassword: '', confirmPassword: '' });
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [accountNotice, setAccountNotice] = useState('');
  const [leaderboardSortBy, setLeaderboardSortBy] = useState('cumulative'); // 'cumulative' | 'elo'
  const [attemptDetails, setAttemptDetails] = useState(null);
  const [submittingTest, setSubmittingTest] = useState(false);
  const [submissionError, setSubmissionError] = useState('');
  const [submissionNotice, setSubmissionNotice] = useState('');
  const [testExpirationNotice, setTestExpirationNotice] = useState('');
  const submissionInProgressRef = useRef(false);

  const catalogOptions = useMemo(() => getCatalogOptions(problems, DEMO_MODE), [problems]);
  const visibleCatalogProblems = useMemo(
    () => filterCatalogProblems(problems, catalogFilters, DEMO_MODE),
    [problems, catalogFilters]
  );
  const hasCatalogFilters = Object.values(catalogFilters).some(Boolean);

  const clearDashboardData = useCallback(() => {
    setProblems([]);
    setTests([]);
    setAttempts([]);
    setStudents([]);
    setSelectedStudentId(null);
    setSelectedStudent(null);
    setCatalogFilters(EMPTY_CATALOG_FILTERS);
    setSelectedTestAnalytics(null);
    setAttemptDetails(null);
  }, []);

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
    setStudentClassEloVisible(true);
    setTeacherSettingsLoading(true);
    setTeacherSettingsSaving(false);
    setTeacherSettingsError('');
    setClassElo(null);
    setClassEloStatus('idle');
    setClassEloError('');
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

  // Create axios instance with useMemo with useMemo to prevent recreation on every render
  const api = useMemo(() => {
    return axios.create({
      baseURL: API_URL,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
  }, [token]);

  useEffect(() => {
    const syncProblemRoute = () => {
      const match = window.location.pathname.match(/^\/problems\/(\d+)$/);
      setActiveProblemId(match ? Number(match[1]) : null);
    };
    window.addEventListener('popstate', syncProblemRoute);
    return () => window.removeEventListener('popstate', syncProblemRoute);
  }, []);

  const openProblemView = (problemId) => {
    const id = Number(problemId);
    if (!Number.isSafeInteger(id) || id < 1) return;
    window.history.pushState({ problemBankView: true }, '', `/problems/${id}`);
    setActiveProblemId(id);
  };

  const closeProblemView = () => window.history.back();

  const loadTeacherSettings = useCallback(async () => {
    if (user?.role !== 'teacher') return;
    const requestToken = token;
    setTeacherSettingsLoading(true);
    setTeacherSettingsError('');
    try {
      const { data } = await api.get('/api/teacher/settings');
      if (localStorage.getItem('token') !== requestToken) return;
      setStudentClassEloVisible(data.studentClassEloVisible === true);
    } catch (error) {
      if (localStorage.getItem('token') !== requestToken) return;
      if (error.response?.status === 401) {
        handleLogout();
        return;
      }
      setTeacherSettingsError('Could not load the class ELO setting. Retry before changing it.');
    } finally {
      if (localStorage.getItem('token') === requestToken) setTeacherSettingsLoading(false);
    }
  }, [api, handleLogout, token, user?.role]);

  useEffect(() => {
    if (user?.role === 'teacher') loadTeacherSettings();
  }, [loadTeacherSettings, user?.role]);

  const updateStudentClassEloVisibility = async (visible) => {
    const requestToken = token;
    setTeacherSettingsSaving(true);
    setTeacherSettingsError('');
    try {
      const { data } = await api.put('/api/teacher/settings', { studentClassEloVisible: visible });
      if (localStorage.getItem('token') !== requestToken) return;
      setStudentClassEloVisible(data.studentClassEloVisible === true);
    } catch (error) {
      if (localStorage.getItem('token') !== requestToken) return;
      if (error.response?.status === 401) {
        handleLogout();
        return;
      }
      setTeacherSettingsError('Could not save this setting. Your previous server setting is still in effect.');
    } finally {
      if (localStorage.getItem('token') === requestToken) setTeacherSettingsSaving(false);
    }
  };

  const loadClassElo = useCallback(async () => {
    if (user?.role !== 'student') return;
    const requestToken = token;
    setClassElo(null);
    setClassEloStatus('loading');
    setClassEloError('');
    try {
      const { data } = await api.get('/api/class/elo');
      if (localStorage.getItem('token') !== requestToken) return;
      if (data.available === true && Number.isFinite(data.classElo)) {
        setClassElo(data.classElo);
        setClassEloStatus('available');
      } else {
        setClassElo(null);
        setClassEloStatus('unavailable');
      }
    } catch (error) {
      if (localStorage.getItem('token') !== requestToken) return;
      setClassElo(null);
      if (error.response?.status === 401) {
        handleLogout();
        return;
      }
      if (error.response?.status === 403) {
        setClassEloStatus('unavailable');
      } else {
        setClassEloStatus('error');
        setClassEloError('Could not load the anonymous class average.');
      }
    }
  }, [api, handleLogout, token, user?.role]);

  useEffect(() => {
    if (user?.role === 'student') loadClassElo();
  }, [loadClassElo, user?.role]);

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
        const [problemsRes, testsRes, studentsRes] = await Promise.all([
          api.get('/api/problems'),
          api.get('/api/tests'),
          api.get('/api/students')
        ]);
        if (localStorage.getItem('token') !== requestToken) return;
        setProblems(problemsRes.data);
        setTests(testsRes.data);
        setStudents(studentsRes.data);
      } else if (userData.role === 'admin') {
        const [problemsRes] = await Promise.all([api.get('/api/problems')]);
        if (localStorage.getItem('token') !== requestToken) return;
        setProblems(problemsRes.data);
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
    // The shared prototype is for exploration, so changing tabs or using another
    // app must not irreversibly consume the one shared student account's attempt.
    // Production exam behavior keeps its existing lockdown policy.
    if (DEMO_MODE || view !== 'taking-test' || !activeTest) return;
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
      const folderIds = [...new Set(testProbs.map(p => getCatalogMetadata(p, DEMO_MODE).group))];
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
    if (!newTest.name.trim() || !newTest.dueDate) {
      setCreateTestError('Add a test name and due date to continue.');
      return;
    }
    if (testSelectionMode === 'manual' && newTest.problemIds.length === 0) {
      setCreateTestError(`Select at least one problem to create a ${newTest.testType === 'target' ? 'Target' : 'Sprint'} test.`);
      return;
    }
    if (testSelectionMode === 'manual' && newTest.testType === 'target' && newTest.problemIds.length !== 8) {
      setCreateTestError('Target tests need exactly 8 problems.');
      return;
    }
    if (testSelectionMode === 'random' && (!/^\d+$/.test(randomCriteria.count) || Number(randomCriteria.count) < 1 || Number(randomCriteria.count) > 200 || (newTest.testType === 'target' && Number(randomCriteria.count) !== 8))) {
      setCreateTestError(newTest.testType === 'target' ? 'Random Target tests need exactly 8 problems.' : 'Choose between 1 and 200 random problems.');
      return;
    }
    const eloCriteriaValid = [randomCriteria.minElo, randomCriteria.maxElo].every(value => value === '' || (/^\d+$/.test(value) && Number(value) >= 0 && Number(value) <= 3000))
      && (randomCriteria.minElo === '' || randomCriteria.maxElo === '' || Number(randomCriteria.minElo) <= Number(randomCriteria.maxElo));
    if (testSelectionMode === 'random' && !eloCriteriaValid) {
      setCreateTestError('Enter whole-number Elo limits from 0 to 3000, with the minimum no higher than the maximum.');
      return;
    }

    setCreateTestError('');
    try {
      await api.post('/api/tests', {
        name: newTest.name,
        ...(testSelectionMode === 'random'
          ? { randomCriteria: { ...randomCriteria, count: Number(randomCriteria.count) } }
          : { problemIds: newTest.problemIds }),
        dueDate: newTest.dueDate,
        timeLimit: newTest.timeLimit,
        testType: newTest.testType
      });
      setNewTest({ name: '', problemIds: [], dueDate: '', timeLimit: 30, testType: 'sprint' });
      setTestSelectionMode('manual');
      setRandomCriteria({ count: '8', minElo: '', maxElo: '', year: '', level: '', round: '' });
      loadUserData();
      setView('teacher-dashboard');
    } catch (error) {
      setCreateTestError(error.response?.data?.error || 'Could not create the test. Please try again.');
    }
  };

  const openAccountSettings = () => {
    setAccountReturnView(view);
    setAccountForm({ username: '', currentPassword: '', newPassword: '', confirmPassword: '' });
    setAccountError('');
    setAccountNotice('');
    setView('account-settings');
  };

  const saveAccountSettings = async (event) => {
    event.preventDefault();
    if (accountForm.newPassword && accountForm.newPassword !== accountForm.confirmPassword) {
      setAccountError('The new passwords do not match.');
      return;
    }
    setAccountBusy(true);
    setAccountError('');
    try {
      const payload = { currentPassword: accountForm.currentPassword };
      if (accountForm.username.trim()) payload.username = accountForm.username.trim();
      if (accountForm.newPassword) payload.newPassword = accountForm.newPassword;
      const { data } = await api.put('/api/me', payload);
      localStorage.setItem('token', data.token);
      setToken(data.token);
      setUser(data.user);
      setAccountForm({ username: '', currentPassword: '', newPassword: '', confirmPassword: '' });
      setAccountNotice('Account settings saved. Other signed-in sessions have been closed.');
    } catch (error) {
      if (error.response?.status === 401 && error.response?.data?.error !== 'Current password is incorrect.') {
        handleLogout('Your session expired. Sign in again to continue.');
        return;
      }
      setAccountError(error.response?.data?.error || 'Could not save account settings. Please try again.');
    } finally {
      setAccountBusy(false);
    }
  };

  const removeSelectedStudent = async () => {
    if (!selectedStudent?.id) return;
    setStudentRemovalBusy(true);
    setStudentRemovalError('');
    try {
      await api.delete(`/api/students/${selectedStudent.id}`);
      setStudents(current => current.filter(student => student.id !== selectedStudent.id));
      setStudentRemovalOpen(false);
      setSelectedStudentId(null);
      setSelectedStudent(null);
      setView('teacher-dashboard');
    } catch (error) {
      setStudentRemovalError(error.response?.data?.error || 'Could not remove this student. Please try again.');
    } finally {
      setStudentRemovalBusy(false);
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
      image_url: editingProblem.image_url || null,
      source: (editingProblem.source ?? '').trim() || null,
      folder_id: editingProblem.folder_id ?? null,
      year: editingProblem.year || null,
      level: (editingProblem.level ?? '').trim() || null,
      round: (editingProblem.round ?? '').trim() || null,
      problem_number: editingProblem.problem_number || null,
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

  const bulkDeleteProblems = async () => {
    if (selectedProblemIds.length === 0) return;
    const visibleIds = new Set(visibleCatalogProblems.map(problem => problem.id));
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
    if (Array.from(password).length < 12 || new TextEncoder().encode(password).length > 72) {
      alert('Student passwords must be at least 12 characters and no more than 72 UTF-8 bytes.');
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
    <>
      <DemoBanner />
      <div className="min-h-screen bg-[#f1f6fd] flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-xl bg-white p-6 text-center shadow">
          <h1 className="mb-2 text-xl font-semibold text-gray-800">Session check unavailable</h1>
          <p className="mb-5 text-sm text-gray-600">{sessionError}</p>
          <div className="flex justify-center gap-3">
            <button type="button" onClick={() => loadUserData()} className="rounded-lg bg-[#2a61ba] px-4 py-2 text-sm font-medium text-white">Retry</button>
            <button type="button" onClick={handleLogout} className="rounded-lg border px-4 py-2 text-sm text-gray-700">Log out</button>
          </div>
        </div>
      </div>
    </>
  );
}

if (view === 'login') {
  return (
    <>
      <DemoBanner />
      <AuthLayout demoMode={DEMO_MODE}>
        <div className="auth-card">
          <p className="auth-kicker">Welcome back</p>
          <h1>Sign in to your team</h1>
          <p className="auth-subtitle">{DEMO_MODE ? 'Continue to the shared practice prototype.' : 'Continue to your MATHCOUNTS practice space.'}</p>
          {DEMO_MODE && <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-3 py-3 text-sm leading-5 text-sky-950" role="note">
            <p>Use a fictional shared demo account. Signup is disabled; this preview is separate from production.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => setLoginForm({ username: DEMO_TEACHER_USERNAME, password: DEMO_TEACHER_PASSWORD })} className="min-h-10 rounded-lg border border-sky-300 bg-white px-3 font-semibold text-sky-900 hover:bg-sky-100">Fill teacher login</button>
              <button type="button" onClick={() => setLoginForm({ username: DEMO_STUDENT_USERNAME, password: DEMO_STUDENT_PASSWORD })} className="min-h-10 rounded-lg border border-sky-300 bg-white px-3 font-semibold text-sky-900 hover:bg-sky-100">Fill student login</button>
            </div>
            <p className="mt-2 text-xs">Teacher password: <code className="rounded bg-white px-1">{DEMO_TEACHER_PASSWORD}</code> · Student password: <code className="rounded bg-white px-1">{DEMO_STUDENT_PASSWORD}</code></p>
          </div>}
          {authError && <div className="auth-alert" role="alert">{authError}</div>}
          <form onSubmit={handleLogin} className="auth-form">
            <div className="auth-field">
              <label htmlFor="login-username">Username</label>
              <input id="login-username" name="username" type="text" autoComplete="username" value={loginForm.username} onChange={e => setLoginForm({ ...loginForm, username: e.target.value })} required />
            </div>
            <PasswordField id="login-password" value={loginForm.password} onChange={e => setLoginForm({ ...loginForm, password: e.target.value })} autoComplete="current-password" visible={showPassword} onToggle={() => setShowPassword(value => !value)} />
            <button type="submit" className="auth-primary-button" disabled={authBusy}>{authBusy ? 'Signing in…' : 'Sign in'}</button>
          </form>
          {!DEMO_MODE && <p className="auth-switch">New teacher? <button type="button" onClick={() => { setAuthError(''); setView('signup'); }}>Create an account</button></p>}
        </div>
      </AuthLayout>
    </>
  );
}

if (view === 'signup') {
  return (
    <>
      <DemoBanner />
      <AuthLayout demoMode={DEMO_MODE}>
        <div className="auth-card">
          {DEMO_MODE ? (
            <>
              <p className="auth-kicker">Shared preview</p>
              <h1>Teacher signup is off</h1>
              <p className="auth-subtitle">Use the fictional teacher or student credentials supplied with this preview.</p>
              <button type="button" className="auth-primary-button w-full" onClick={() => setView('login')}>Back to sign in</button>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      </AuthLayout>
    </>
  );
}

if (view === 'taking-test' && activeTest) {
  return (
    <>
      <DemoBanner />
      <StudentTestPage
        activeTest={activeTest}
        demoMode={DEMO_MODE}
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
    </>
  );
}

if (view === 'student-dashboard' && user) {
  const availableTests = tests.filter(
    (t) => !attempts.find((a) => a.test_id === t.id)
  );

  return (
    <>
      <DemoBanner />
      <main className="min-h-screen bg-[#f1f6fd] flex justify-center">
        <div className="w-full max-w-6xl p-6">

        <PracticeHeader audience="Student workspace" demoMode={DEMO_MODE} onLogout={handleLogout} onSettings={openAccountSettings} />
        <FolioIntro title={`Ready when you are, ${user.username}.`} description="Find your next practice below. Take it one problem at a time." count={availableTests.length} countLabel="tests to explore" />

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

        {/* Content */}
        <div className="grid md:grid-cols-2 gap-6">

          {/* Available Tests */}
          <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-800">
              Available Tests
            </h2>

            {availableTests.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-gray-500 text-center">
                {DEMO_MODE ? 'No fresh tests available. The shared student account can take each assignment once; ask the demo teacher to create a new assignment for another run.' : 'You’re all caught up. New tests from your teacher will appear here.'}
              </div>
            ) : (
              <div className="space-y-3">
                {availableTests.map((test) => (
                  <div key={test.id} className="bg-white rounded-xl shadow p-4">
                    <h3 className="font-semibold text-gray-800 mb-1">
                      {test.name}
                    </h3>
                    <p className="text-sm text-gray-500 mb-3">
                      {test.test_type === 'target' ? 'Target' : 'Sprint'} · {(test.problem_ids || []).length} questions ·{' '}
                      {test.time_limit} min
                    </p>
                    <p className="mb-3 text-xs leading-5 text-gray-600">{DEMO_MODE ? 'Demo scoring: ' : 'Scoring: '}{test.test_type === 'target' ? '2 points per correct answer.' : '1 point per correct answer.'} ELO updates separately for each problem.</p>
                    {!DEMO_MODE && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">This test submits automatically if you switch to another tab or app. Keep it open in the foreground until you finish.</p>}
                    <button
                      type="button"
                      onClick={() => startTest(test)}
                      disabled={startingTestId !== null || test.session_expired}
                      aria-busy={startingTestId === test.id}
                      className="w-full bg-[#2a61ba] hover:bg-[#20529f] disabled:cursor-not-allowed disabled:opacity-70 text-white py-2 rounded-lg text-sm font-medium"
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
            <h2 className="text-lg font-semibold mb-4 text-gray-800">
              Test History
            </h2>
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
                      <h3 className="font-semibold text-gray-800 mb-1">
                        {test?.name || 'Unknown Test'}
                      </h3>
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
                        className="mt-2 text-sm text-[#2a61ba] font-medium hover:underline"
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

        {/* Progress summary */}
        <div className="progress-summary bg-white rounded-xl p-6 mt-8">
          <h2 className="text-2xl font-semibold text-gray-800 mb-1">
            Your progress
          </h2>
          <p className="text-sm text-gray-500 mb-4">
            A snapshot of what you’re learning
          </p>

          <div className="flex flex-wrap gap-4 justify-start">
            <div className="inline-flex flex-col items-center bg-[#e6effb] px-6 py-4 rounded-xl" title="Skill rating based on problem difficulty and correctness; increases when you solve harder problems correctly, decreases when you miss easier ones">
              <span className="text-xs text-gray-600 mb-1">Overall ELO</span>
              <span className="text-4xl font-bold text-[#2a61ba]">{user.elo}</span>
            </div>
            {typeof user.cumulative_score === 'number' && (
              <div className="inline-flex flex-col items-center bg-white border border-gray-200 px-6 py-4 rounded-xl" title="Sprint problems correct + 2× target problems correct">
                <span className="text-xs text-gray-600 mb-1">Cumulative Score</span>
                <span className="text-4xl font-bold text-[#2a61ba]">
                  {user.cumulative_score}
                </span>
              </div>
            )}
          </div>
          <p className="mt-3 max-w-xl text-xs leading-5 text-gray-600">
            ELO is a skill estimate that adjusts based on which problems you solve correctly. It is not a grade. Class averages are anonymous and shown only when the group is large enough.
          </p>
          {classEloStatus !== 'idle' && (
            <div className="mt-4 max-w-sm rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-left" aria-live="polite">
              <h3 className="text-sm font-semibold text-gray-800">Anonymous class ELO average</h3>
              {classEloStatus === 'loading' && <p className="mt-1 text-sm text-gray-600">Loading class average…</p>}
              {classEloStatus === 'available' && <p className="mt-1 text-2xl font-bold text-[#2a61ba]">{classElo}</p>}
              {classEloStatus === 'unavailable' && (
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <p className="text-gray-600">Not available. Your teacher may have hidden it, or the class needs more learners for a private aggregate.</p>
                  <button type="button" onClick={loadClassElo} className="font-semibold text-[#2a61ba] underline">Check again</button>
                </div>
              )}
              {classEloStatus === 'error' && (
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <p className="text-red-800" role="alert">{classEloError}</p>
                  <button type="button" onClick={loadClassElo} className="font-semibold text-[#2a61ba] underline">Retry</button>
                </div>
              )}
            </div>
          )}
        </div>


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
                    <div className="mb-4 p-3 bg-[#e6effb] rounded-lg border border-[#2a61ba]/30">
                      <span className="text-sm font-medium text-gray-700">Solutions: </span>
                      <a href={attemptDetails.solutionsLink} target="_blank" rel="noopener noreferrer" className="text-[#2a61ba] hover:underline font-medium">
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
                            <span className="block mt-1 text-[#2a61ba]"><span className="font-medium">Correct answer:</span> {String(item.correct_answer ?? '')}</span>
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
      </main>
    </>
  );
}


if (view === 'teacher-dashboard' && user) {
  return (
    <main className="min-h-screen bg-[#f1f6fd]">
      <DemoBanner />
      <PracticeHeader audience="Teacher workspace" demoMode={DEMO_MODE} onLogout={handleLogout} onSettings={openAccountSettings} />

      <div className="max-w-7xl mx-auto px-6 py-8">
        {dashboardLoadError && (
          <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <span>{dashboardLoadError}</span>
            <button type="button" onClick={() => loadUserData({ preserveView: true })} className="font-semibold underline">Retry loading</button>
          </div>
        )}
        <FolioIntro title="A little practice. A lot of possibility." description="Build a thoughtful test, bring your team together, and see what clicks." count={tests.length} countLabel="tests in your collection">
          <button type="button" onClick={() => setView('create-test')} className="folio-primary">Create test</button>
          {!DEMO_MODE && <button type="button" onClick={() => setView('register-students')} className="folio-secondary">Manage students</button>}
          {!DEMO_MODE && <button type="button" onClick={() => setView('teacher-admin')} className="folio-secondary">Problem bank</button>}
          {DEMO_MODE && <button type="button" onClick={() => setView('prototype-insights')} className="folio-secondary">Class insights · aggregate only</button>}
        </FolioIntro>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Tests */}
          <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-800">
              Your Tests
            </h2>

            {tests.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-6 text-center text-gray-500">
                Your first practice starts here.
                <button type="button" onClick={() => setView('create-test')} className="mt-3 block mx-auto font-semibold text-[#2a61ba] underline">Create your first test</button>
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

                    {DEMO_MODE ? (
                      <div>
                        <span className="text-sm font-medium text-gray-700">
                          Class insights are available in the aggregate view.
                        </span>
                        <p className="mt-1 text-xs text-gray-600">These trends include the whole demo class; they are not specific to this test or student.</p>
                      </div>
                    ) : (
                      <button
                        onClick={async () => {
                          await loadTestAnalytics(test.id);
                          setView('test-analytics');
                        }}
                        className="text-sm text-[#2a61ba] font-medium hover:underline"
                      >
                        View Analytics →
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Student leaderboard */}
          {!DEMO_MODE && <div>
            <h2 className="text-lg font-semibold mb-4 text-gray-800">
              Student Leaderboard
            </h2>
            <div className="flex flex-wrap items-center gap-4 mb-3">
              <p className="text-sm text-gray-500">
                Click a name to view their profile. Only students you register can see your tests.
              </p>
              <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
                <label htmlFor={`rank-by-${view}`} className="text-sm text-gray-600">Rank by:</label>
                <select
                  id={`rank-by-${view}`}
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
                  No students yet. <button type="button" onClick={() => setView('register-students')} className="text-[#2a61ba] font-medium hover:underline">Register students</button> to get started.
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
                      <div className="flex flex-wrap justify-between items-center gap-3 min-w-0">
                        <button
                          type="button"
                          onClick={() => { setSelectedStudentId(s.id); setView('student-profile'); }}
                          className="min-w-0 [overflow-wrap:anywhere] font-medium text-left hover:text-[#2a61ba] hover:underline"
                        >
                          {i + 1}. {s.username}
                        </button>
                        <div className="flex flex-wrap gap-4">
                          {typeof s.cumulative_score === 'number' && (
                            <span className="text-gray-600" title="Sprint problems correct + 2× target problems correct">
                              Cumulative: <span className="font-semibold text-[#2a61ba]">{s.cumulative_score}</span>
                            </span>
                          )}
                          <span className="text-[#2a61ba] font-semibold" title="Skill rating based on problem difficulty and correctness">
                            ELO: {s.elo}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))
              )}
            </div>
          </div>}
        </div>
        <section className="mt-8 rounded-xl border border-gray-200 bg-white p-4 shadow-sm" aria-labelledby="elo-visibility-title">
          <h2 id="elo-visibility-title" className="text-sm font-semibold text-gray-900">Anonymous class ELO average</h2>
          <label className="mt-2 flex items-start gap-3 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={studentClassEloVisible}
              disabled={teacherSettingsLoading || teacherSettingsSaving || Boolean(teacherSettingsError)}
              onChange={event => updateStudentClassEloVisibility(event.target.checked)}
              aria-describedby="elo-visibility-help"
              className="mt-1"
            />
            <span>Show the anonymous class ELO average to students</span>
          </label>
          <p id="elo-visibility-help" className="ml-7 mt-1 text-xs leading-5 text-gray-600">
            The server suppresses the average when the class is too small to protect student privacy. Individual student ratings remain part of each student’s progress view.
          </p>
          {teacherSettingsLoading && <p className="ml-7 mt-2 text-sm text-gray-600" role="status">Loading saved setting…</p>}
          {teacherSettingsSaving && <p className="ml-7 mt-2 text-sm text-gray-600" role="status">Saving setting…</p>}
          {teacherSettingsError && (
            <div className="ml-7 mt-2 flex flex-wrap items-center gap-3">
              <p className="text-sm text-red-800" role="alert">{teacherSettingsError}</p>
              <button type="button" onClick={loadTeacherSettings} disabled={teacherSettingsLoading} className="text-sm font-semibold text-[#2a61ba] underline disabled:opacity-50">Retry</button>
            </div>
          )}
        </section>

      </div>
    </main>
  );
}

if (DEMO_MODE && view === 'test-analytics' && user?.role === 'teacher') {
  return (
    <>
      <DemoBanner />
      <main className="min-h-screen bg-[#f1f6fd] px-4 py-8 sm:px-6">
        <section className="mx-auto max-w-xl rounded-xl border border-gray-200 bg-white p-6 shadow-sm" aria-labelledby="demo-analytics-title">
          <h1 id="demo-analytics-title" className="text-xl font-semibold text-gray-900">Per-test analytics are unavailable in this shared demo</h1>
          <p className="mt-3 text-sm leading-6 text-gray-700">The preview provides aggregate class insights only. Student-level results and editable test settings are disabled here.</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" onClick={() => setView('prototype-insights')} className="min-h-11 rounded-lg bg-[#2a61ba] px-4 py-2 text-sm font-semibold text-white hover:bg-[#20529f] focus-visible:outline">
              View aggregate class insights
            </button>
            <button type="button" onClick={() => setView('teacher-dashboard')} className="min-h-11 rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 focus-visible:outline">
              Back to dashboard
            </button>
          </div>
        </section>
      </main>
    </>
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


  return (
    <div className="min-h-screen bg-[#f1f6fd] flex justify-center">
      <div className="w-full max-w-4xl p-6">
        <DemoBanner />
        <div className="bg-white rounded-xl shadow p-6 mb-6 flex flex-wrap gap-3 justify-between items-center">
          <button
            type="button"
            onClick={() => setView('teacher-dashboard')}
            className="text-sm text-[#2a61ba] hover:underline"
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
                className="px-4 py-2 bg-[#2a61ba] text-white rounded-lg text-sm font-medium hover:bg-[#20529f]"
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
                            className="text-sm text-[#2a61ba] font-medium hover:underline"
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
                      <div className="mb-4 p-3 bg-[#e6effb] rounded-lg border border-[#2a61ba]/30">
                        <span className="text-sm font-medium text-gray-700">Solutions: </span>
                        <a href={attemptDetails.solutionsLink} target="_blank" rel="noopener noreferrer" className="text-[#2a61ba] hover:underline font-medium">
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
                              <span className="block mt-1 text-[#2a61ba]"><span className="font-medium">Correct:</span> {String(item.correct_answer ?? '')}</span>
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


        </div>
      </div>
    </div>
  );
}

if (view === 'prototype-insights' && DEMO_MODE && user?.role === 'teacher') {
  return (
    <>
      <DemoBanner />
      <PrototypeInsights api={api} onBack={() => setView('teacher-dashboard')} />
    </>
  );
}

if (view === 'register-students' && user) {
  return (
    <div className="min-h-screen bg-[#f1f6fd] flex justify-center">
      <div className="w-full max-w-2xl p-6">
        <DemoBanner />
        <div className="bg-white rounded-xl shadow p-6 mb-6 flex flex-wrap gap-3 justify-between items-center">
          <button
            onClick={() => setView('teacher-dashboard')}
            className="text-sm text-[#2a61ba] hover:underline"
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
              autoComplete="new-password"
              value={newStudent.password}
              onChange={(e) => setNewStudent({ ...newStudent, password: e.target.value })}
              className="border rounded-lg px-4 py-2 flex-1 min-w-[120px]"
            />
            <button
              type="button"
              onClick={() => registerStudent()}
              className="bg-[#2a61ba] hover:bg-[#20529f] text-white px-5 py-2 rounded-lg font-medium"
            >
              Add student
            </button>
          </div>
          <p className="mt-2 text-xs leading-5 text-gray-600">Use at least 12 characters. Passwords are limited to 72 UTF-8 bytes.</p>
        </div>

        <div className="bg-white rounded-xl shadow">
          <h2 className="text-base font-semibold text-gray-800 p-4 pb-2">My students</h2>
          <div className="flex flex-wrap items-center gap-4 px-4 pb-4">
            <p className="text-sm text-gray-500">
              Only these students can see and take your tests.
            </p>
            <div className="flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2">
              <label htmlFor={`rank-by-${view}`} className="text-sm text-gray-600">Rank by:</label>
              <select
                id={`rank-by-${view}`}
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
                    <div className="flex flex-wrap justify-between items-center gap-3 min-w-0">
                      <button
                        type="button"
                        onClick={() => { setSelectedStudentId(s.id); setView('student-profile'); }}
                        className="min-w-0 [overflow-wrap:anywhere] font-medium text-left hover:text-[#2a61ba] hover:underline"
                      >
                        {i + 1}. {s.username}
                      </button>
                      <div className="flex flex-wrap gap-4">
                        {typeof s.cumulative_score === 'number' && (
                          <span className="text-gray-600" title="Sprint problems correct + 2× target problems correct">
                            Cumulative: <span className="font-semibold text-[#2a61ba]">{s.cumulative_score}</span>
                          </span>
                        )}
                        <span className="text-[#2a61ba] font-semibold" title="Skill rating based on problem difficulty and correctness">
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
      <div className="min-h-screen bg-[#f1f6fd]">
        <DemoBanner />
        <div className="flex min-h-[60vh] items-center justify-center">
          <p className="text-gray-500">Loading student profile...</p>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-[#f1f6fd] flex justify-center">
      <div className="w-full max-w-4xl p-6">
        <DemoBanner />
        <div className="bg-white rounded-xl shadow p-6 mb-6 flex flex-wrap gap-3 justify-between items-center">
          <button
            onClick={() => { setView('teacher-dashboard'); setSelectedStudentId(null); setSelectedStudent(null); }}
            className="text-sm text-[#2a61ba] hover:underline"
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
            <div className="inline-flex flex-col items-center bg-[#e6effb] px-6 py-4 rounded-xl" title="Skill rating based on problem difficulty and correctness; increases when solving harder problems correctly, decreases when missing easier ones">
              <span className="text-xs text-gray-600 mb-1">Overall ELO</span>
              <span className="text-2xl font-bold text-[#2a61ba]">{selectedStudent.elo}</span>
            </div>
            <div className="inline-flex flex-col items-center bg-white border border-gray-200 px-6 py-4 rounded-xl" title="Sprint problems correct + 2× target problems correct">
              <span className="text-xs text-gray-600 mb-1">Cumulative Score</span>
              <span className="text-2xl font-bold text-[#2a61ba]">{selectedStudent.cumulative_score ?? 0}</span>
            </div>
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

        {!DEMO_MODE && <section className="mt-6 rounded-xl border border-red-200 bg-white p-6" aria-labelledby="remove-student-heading">
          <h2 id="remove-student-heading" className="text-base font-semibold text-gray-900">Remove student</h2>
          <p className="mt-2 text-sm leading-6 text-gray-600">Remove {selectedStudent.username} from your active roster. Their completed work and ratings will stay in the records.</p>
          <button type="button" onClick={() => { setStudentRemovalError(''); setStudentRemovalOpen(true); }} className="mt-4 rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">Remove this student</button>
        </section>}
      </div>
      {studentRemovalOpen && <ConfirmationDialog title={`Remove ${selectedStudent.username}?`} description="They will no longer be able to sign in or appear in your active roster. Their completed tests and rating history will be preserved." confirmLabel="Remove student" busyLabel="Removing…" busy={studentRemovalBusy} error={studentRemovalError} onConfirm={removeSelectedStudent} onCancel={() => !studentRemovalBusy && setStudentRemovalOpen(false)} />}
    </div>
  );
}

if (view === 'account-settings' && user) {
  return (
    <main className="min-h-screen bg-[#f1f6fd] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-2xl">
        <DemoBanner />
        <section className="rounded-2xl bg-white p-6 shadow sm:p-8">
          <button type="button" onClick={() => { setView(accountReturnView); setAccountNotice(''); }} className="mb-5 text-sm font-medium text-[#2a61ba] hover:underline">← Back</button>
          <p className="text-sm font-semibold uppercase tracking-wide text-[#2a61ba]">Account</p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">Account settings</h1>
          <p className="mt-2 text-sm leading-6 text-gray-600">Signed in as <strong>{user.username}</strong>. Verify your current password to change your username or password.</p>
          {accountNotice && <p role="status" className="mt-5 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">{accountNotice}</p>}
          <form onSubmit={saveAccountSettings} className="mt-6 space-y-5">
            <div>
              <label htmlFor="account-username" className="mb-1.5 block text-sm font-medium text-gray-700">New username <span className="font-normal text-gray-500">(optional)</span></label>
              <input id="account-username" autoComplete="username" minLength={3} maxLength={50} value={accountForm.username} onChange={event => setAccountForm({ ...accountForm, username: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2.5" placeholder={user.username} />
            </div>
            <div>
              <label htmlFor="account-current-password" className="mb-1.5 block text-sm font-medium text-gray-700">Current password</label>
              <input id="account-current-password" type="password" autoComplete="current-password" required value={accountForm.currentPassword} onChange={event => setAccountForm({ ...accountForm, currentPassword: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2.5" />
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="account-new-password" className="mb-1.5 block text-sm font-medium text-gray-700">New password <span className="font-normal text-gray-500">(optional)</span></label>
                <input id="account-new-password" type="password" autoComplete="new-password" minLength={12} value={accountForm.newPassword} onChange={event => setAccountForm({ ...accountForm, newPassword: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2.5" />
                <p className="mt-1 text-xs text-gray-500">Use at least 12 characters.</p>
              </div>
              <div>
                <label htmlFor="account-confirm-password" className="mb-1.5 block text-sm font-medium text-gray-700">Confirm new password</label>
                <input id="account-confirm-password" type="password" autoComplete="new-password" value={accountForm.confirmPassword} onChange={event => setAccountForm({ ...accountForm, confirmPassword: event.target.value })} className="w-full rounded-lg border border-gray-300 px-3 py-2.5" />
              </div>
            </div>
            {accountError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{accountError}</p>}
            <button type="submit" disabled={accountBusy || !accountForm.currentPassword || (!accountForm.username.trim() && !accountForm.newPassword)} className="w-full rounded-lg bg-[#2a61ba] px-4 py-3 font-semibold text-white hover:bg-[#20529f] disabled:cursor-not-allowed disabled:opacity-50">{accountBusy ? 'Saving…' : 'Save account settings'}</button>
          </form>
        </section>
      </div>
    </main>
  );
}

if (view === 'create-test' && user) {
  const changeTestType = (type) => {
    setNewTest(current => ({ ...current, testType: type }));
    if (type === 'target') setRandomCriteria(current => ({ ...current, count: '8' }));
    else setRandomCriteria(current => ({ ...current, count: current.count === '8' ? '10' : current.count }));
  };
  const randomEligibleCount = problems.filter(problem => {
    const metadata = getCatalogMetadata(problem, DEMO_MODE);
    const elo = Number(problem.elo);
    return (!randomCriteria.year || metadata.year === String(randomCriteria.year))
      && (!randomCriteria.level || metadata.level === randomCriteria.level)
      && (!randomCriteria.round || metadata.round === randomCriteria.round)
      && (randomCriteria.minElo === '' || elo >= Number(randomCriteria.minElo))
      && (randomCriteria.maxElo === '' || elo <= Number(randomCriteria.maxElo));
  }).length;
  const randomEloRangeValid = [randomCriteria.minElo, randomCriteria.maxElo].every(value => value === '' || (/^\d+$/.test(value) && Number(value) >= 0 && Number(value) <= 3000))
    && (randomCriteria.minElo === '' || randomCriteria.maxElo === '' || Number(randomCriteria.minElo) <= Number(randomCriteria.maxElo));
  const randomSelectionValid = /^\d+$/.test(randomCriteria.count)
    && Number(randomCriteria.count) >= 1
    && Number(randomCriteria.count) <= 200
    && (newTest.testType !== 'target' || Number(randomCriteria.count) === 8)
    && randomEloRangeValid
    && randomEligibleCount >= Number(randomCriteria.count);
  const hiddenSelectedProblemCount = newTest.problemIds.filter(
    id => !visibleCatalogProblems.some(problem => problem.id === id)
  ).length;
  return (
    <div className="min-h-screen bg-[#f1f6fd] flex justify-center">
      <div className="w-full max-w-4xl p-6">
        <DemoBanner />
        <div className="bg-white rounded-xl shadow p-6 mb-6 flex flex-wrap gap-3 justify-between items-center">
          <button
            onClick={() => setView('teacher-dashboard')}
            className="text-sm text-[#2a61ba] hover:underline"
          >
            ← Back to dashboard
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
                  onChange={() => changeTestType('sprint')}
                  className="mt-1"
                />
                <div>
                  <span className="font-medium text-gray-800">Sprint</span>
                  <p className="text-sm text-gray-500 mt-0.5">Choose any number of problems. Each correct answer is worth 1 point.</p>
                </div>
              </label>
              <label className="flex flex-1 items-start gap-3 rounded-lg border border-gray-200 p-4 cursor-pointer">
                <input
                  type="radio"
                  name="testType"
                  checked={newTest.testType === 'target'}
                  onChange={() => changeTestType('target')}
                  className="mt-1"
                />
                <div>
                  <span className="font-medium text-gray-800">Target</span>
                  <p className="text-sm text-gray-500 mt-0.5">8 problems, 2 points each. {DEMO_MODE ? 'Fictional demo scoring: 2× correct answers.' : 'Counts toward MATHCOUNTS score as 2× correct answers.'}</p>
                </div>
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-gray-700">Problem selection</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${testSelectionMode === 'manual' ? 'border-[#2a61ba] bg-blue-50' : 'border-gray-200'}`}>
                <input type="radio" name="problemSelectionMode" checked={testSelectionMode === 'manual'} onChange={() => setTestSelectionMode('manual')} className="mt-1" />
                <span><span className="block font-medium text-gray-800">Choose problems</span><span className="mt-1 block text-sm text-gray-500">Select each problem from the catalog.</span></span>
              </label>
              <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${testSelectionMode === 'random' ? 'border-[#2a61ba] bg-blue-50' : 'border-gray-200'}`}>
                <input type="radio" name="problemSelectionMode" checked={testSelectionMode === 'random'} onChange={() => setTestSelectionMode('random')} className="mt-1" />
                <span><span className="block font-medium text-gray-800">Choose randomly</span><span className="mt-1 block text-sm text-gray-500">Let the system select from matching catalog problems.</span></span>
              </label>
            </div>
          </fieldset>

          {testSelectionMode === 'random' && <section className="rounded-xl border border-gray-200 bg-gray-50 p-4 sm:p-5" aria-labelledby="random-criteria-heading">
            <h2 id="random-criteria-heading" className="font-semibold text-gray-900">Random problem filters</h2>
            <p className="mt-1 text-sm text-gray-600">Every filter is optional. The selection is made securely when you create the test.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label htmlFor="random-count" className="mb-1 block text-sm font-medium text-gray-700">Number of problems</label>
                <input id="random-count" type="number" min={newTest.testType === 'target' ? 8 : 1} max={newTest.testType === 'target' ? 8 : 200} step="1" value={randomCriteria.count} disabled={newTest.testType === 'target'} onChange={event => setRandomCriteria({ ...randomCriteria, count: event.target.value })} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 disabled:bg-gray-100" />
                {newTest.testType === 'target' && <p className="mt-1 text-xs text-gray-500">Target tests contain exactly 8 problems.</p>}
              </div>
              <div>
                <label htmlFor="random-min-elo" className="mb-1 block text-sm font-medium text-gray-700">Minimum Elo</label>
                <input id="random-min-elo" type="number" min="0" max="3000" step="1" value={randomCriteria.minElo} onChange={event => setRandomCriteria({ ...randomCriteria, minElo: event.target.value })} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5" placeholder="Any" />
              </div>
              <div>
                <label htmlFor="random-max-elo" className="mb-1 block text-sm font-medium text-gray-700">Maximum Elo</label>
                <input id="random-max-elo" type="number" min="0" max="3000" step="1" value={randomCriteria.maxElo} onChange={event => setRandomCriteria({ ...randomCriteria, maxElo: event.target.value })} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5" placeholder="Any" />
              </div>
              <div>
                <label htmlFor="random-year" className="mb-1 block text-sm font-medium text-gray-700">Year</label>
                <select id="random-year" value={randomCriteria.year} onChange={event => setRandomCriteria({ ...randomCriteria, year: event.target.value })} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5"><option value="">Any year</option>{catalogOptions.years.map(year => <option key={year} value={year}>{year}</option>)}</select>
              </div>
              <div>
                <label htmlFor="random-level" className="mb-1 block text-sm font-medium text-gray-700">Level</label>
                <select id="random-level" value={randomCriteria.level} onChange={event => setRandomCriteria({ ...randomCriteria, level: event.target.value })} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5"><option value="">Any level</option>{catalogOptions.levels.map(level => <option key={level} value={level}>{level}</option>)}</select>
              </div>
              <div>
                <label htmlFor="random-round" className="mb-1 block text-sm font-medium text-gray-700">Round</label>
                <select id="random-round" value={randomCriteria.round} onChange={event => setRandomCriteria({ ...randomCriteria, round: event.target.value })} className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5"><option value="">Any round</option>{catalogOptions.rounds.map(round => <option key={round} value={round}>{round}</option>)}</select>
              </div>
            </div>
            <p className="mt-4 text-sm text-gray-700" role="status" aria-live="polite">{randomEligibleCount} accessible problems match these filters. {randomEligibleCount < Number(randomCriteria.count) && 'Widen the filters to include enough problems.'}</p>
          </section>}

          {testSelectionMode === 'manual' && <ProblemCatalogFilters demoMode={DEMO_MODE} filters={catalogFilters} options={catalogOptions} onChange={setCatalogFilters} />}

          {testSelectionMode === 'manual' && <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-gray-800">Choose problems</h2>
            <p className="text-sm text-gray-600" role="status" aria-live="polite">{newTest.problemIds.length} selected{newTest.testType === 'target' ? ' · 8 required' : ' · 200 maximum'}</p>
          </div>
          <p className="-mt-4 text-xs text-gray-600">
            Sprint can include 1–200 problems. Target must include exactly 8. Source identifies where a problem came from and does not limit which test type can use it. Filters only change which items are shown; selected problem IDs remain in this test.
            {hiddenSelectedProblemCount > 0 && ` ${hiddenSelectedProblemCount} selected problem${hiddenSelectedProblemCount === 1 ? ' is' : 's are'} currently hidden by the filters.`}
          </p>
          </>}
          {testSelectionMode === 'manual' && <div className="max-h-96 overflow-y-auto border rounded-lg p-4 space-y-1" role="region" aria-label="Problem selection">
            {(() => {
              const byFolder = {};
              for (const p of visibleCatalogProblems) {
                const fname = getCatalogMetadata(p, DEMO_MODE).group;
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
                    const nextIds = [...new Set([...newTest.problemIds, ...folderIds])];
                    if (nextIds.length > 200) {
                      setCreateTestError('Sprint tests can include at most 200 problems. Deselect some items or choose a smaller folder selection.');
                      return;
                    }
                    setNewTest({ ...newTest, problemIds: nextIds });
                    setCreateTestError('');
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
                        {folderProbs.map(p => {
                    const metadata = getCatalogMetadata(p, DEMO_MODE);
                          return <label key={p.id} className="flex gap-3 text-sm items-center cursor-pointer hover:bg-gray-50 -mx-1 px-2 py-1.5 rounded">
                            <input
                              type="checkbox"
                              checked={newTest.problemIds.includes(p.id)}
                              disabled={!newTest.problemIds.includes(p.id) && newTest.problemIds.length >= 200}
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
                              <span className="ml-2 text-gray-600">Year {metadata.year || '—'} · Level {metadata.level || '—'} · Round {metadata.round || '—'}</span>
                              <span className="text-[#2a61ba] font-medium ml-2">Elo {metadata.elo}</span>
                            </span>
                          </label>
                        })}
                    </div>
                  </div>
                );
              });
            })()}
          </div>}

          {testSelectionMode === 'manual' && visibleCatalogProblems.length === 0 && (
            <p className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600" role="status">No problems match these filters.</p>
          )}

          {createTestError && <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{createTestError}</p>}
          <button
            type="submit"
            disabled={(testSelectionMode === 'manual' && (newTest.problemIds.length === 0 || (newTest.testType === 'target' && newTest.problemIds.length !== 8))) || (testSelectionMode === 'random' && !randomSelectionValid) || !newTest.name.trim() || !newTest.dueDate || !Number.isInteger(Number(newTest.timeLimit)) || Number(newTest.timeLimit) < 1 || Number(newTest.timeLimit) > 240}
            className="w-full bg-[#2a61ba] hover:bg-[#20529f] disabled:cursor-not-allowed disabled:opacity-50 text-white py-3 rounded-lg font-medium"
          >
            Create Test
          </button>
        </form>
      </div>
    </div>
  );
}

if (activeProblemId && user && (user.role === 'teacher' || user.role === 'admin')) {
  return <ProblemDetailPage problemId={activeProblemId} api={api} token={token} onBack={closeProblemView} />;
}

if ((view === 'admin-dashboard' || view === 'teacher-admin') && user) {
  const isTeacherAdmin = user.role === 'teacher';
  const visibleProblemIds = new Set(visibleCatalogProblems.map(problem => problem.id));
  const hiddenSelectedCount = selectedProblemIds.filter(id => !visibleProblemIds.has(id)).length;
  return (
    <div className="min-h-screen bg-[#f1f6fd] flex justify-center">
      <div className="w-full max-w-6xl p-6">
        <DemoBanner />
        <div className="bg-white rounded-xl shadow p-4 mb-6 flex justify-between">
          <h1 className="font-semibold text-gray-800">
            {isTeacherAdmin ? 'Team Problem Bank' : 'Admin Portal'}
          </h1>
          <div className="flex flex-wrap gap-4">
            {isTeacherAdmin && (
              <button
                onClick={() => setView('teacher-dashboard')}
                className="text-sm text-[#2a61ba] hover:underline"
              >
                ← Back to Dashboard
              </button>
            )}
            <button type="button" onClick={openAccountSettings} className="text-sm text-[#2a61ba] hover:underline">Account settings</button>
            <button
              onClick={handleLogout}
              className="text-sm text-[#2a61ba] hover:underline"
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

        {!isTeacherAdmin && (
          <button
            onClick={() => setEditingProblem({ question: '', answer: '', image_url: '', source: '', year: '', level: '', round: '', problem_number: '', folder_id: null })}
            className="mb-6 bg-[#2a61ba] text-white px-6 py-3 rounded-lg"
          >
            Add Problem
          </button>
        )}

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
                  ) : user.role === 'admin' ? (
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
                  ) : (
                    <p className="text-sm text-gray-500">Only administrators can add problem images.</p>
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
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="block text-sm font-medium text-gray-700">Year
                    <input type="number" min="1900" max="2100" value={editingProblem.year ?? ''} onChange={e => setEditingProblem({ ...editingProblem, year: e.target.value })} className="mt-1 w-full px-3 py-2 border rounded-lg" placeholder="2022" />
                  </label>
                  <label className="block text-sm font-medium text-gray-700">Level
                    <input type="text" maxLength="50" value={editingProblem.level ?? ''} onChange={e => setEditingProblem({ ...editingProblem, level: e.target.value })} className="mt-1 w-full px-3 py-2 border rounded-lg" placeholder="Nationals" />
                  </label>
                  <label className="block text-sm font-medium text-gray-700">Round
                    <input type="text" maxLength="50" value={editingProblem.round ?? ''} onChange={e => setEditingProblem({ ...editingProblem, round: e.target.value })} className="mt-1 w-full px-3 py-2 border rounded-lg" placeholder="Sprint" />
                  </label>
                  <label className="block text-sm font-medium text-gray-700">Problem number
                    <input type="number" min="1" max="999" step="1" value={editingProblem.problem_number ?? ''} onChange={e => setEditingProblem({ ...editingProblem, problem_number: e.target.value })} className="mt-1 w-full px-3 py-2 border rounded-lg" placeholder="1" />
                  </label>
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
                    className="flex-1 bg-[#2a61ba] text-white py-2 rounded-lg"
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

        <ProblemCatalogFilters demoMode={DEMO_MODE} filters={catalogFilters} options={catalogOptions} onChange={setCatalogFilters} />

        {selectedProblemIds.length > 0 && (
          <div className="mt-4 bg-[#2a61ba]/10 border border-[#2a61ba]/30 rounded-xl p-4 mb-4 flex flex-wrap items-center gap-3">
            <span className="font-medium text-gray-800">{selectedProblemIds.length} selected</span>
            {hiddenSelectedCount > 0 && <span role="status" className="text-sm text-gray-700">{hiddenSelectedCount} selected problem{hiddenSelectedCount === 1 ? ' is' : 's are'} hidden by this search; bulk actions still include {hiddenSelectedCount} hidden item{hiddenSelectedCount === 1 ? '' : 's'}.</span>}
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

        <section className="mt-8" aria-labelledby="catalog-groups-heading">
          <div className="mb-4">
            <h2 id="catalog-groups-heading" className="text-lg font-semibold text-gray-900">Browse by contest</h2>
          </div>
          <div className="space-y-4">
          {(() => {
            const byGroup = new Map();
            for (const problem of visibleCatalogProblems) {
              const metadata = getCatalogMetadata(problem, DEMO_MODE);
              if (!byGroup.has(metadata.group)) byGroup.set(metadata.group, []);
              byGroup.get(metadata.group).push(problem);
            }
            const groups = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
            if (groups.length === 0 && hasCatalogFilters) {
              return <div role="status" className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-600">No problems match these catalog filters.</div>;
            }
            if (groups.length === 0 && problems.length === 0) {
              return <div className="bg-white rounded-xl shadow p-8 text-center text-gray-500">No problems are available in the bank yet.</div>;
            }
            return groups.map(([name, groupProblems], groupIndex) => {
              const groupKey = `${name}-${groupIndex}`;
              const panelId = `problem-group-panel-${groupIndex}`;
              const expanded = hasCatalogFilters || adminExpandedFolders.has(groupKey);
              const toggle = () => setAdminExpandedFolders(previous => {
                const next = new Set(previous);
                if (next.has(groupKey)) next.delete(groupKey);
                else next.add(groupKey);
                return next;
              });
              return (
                <section key={groupKey} className="bg-white rounded-xl shadow overflow-hidden">
                  <div className="flex items-center px-4 py-3 bg-gray-50 border-b border-gray-200">
                    <button type="button" onClick={toggle} aria-expanded={expanded} aria-controls={panelId} className="flex w-full items-center gap-2 text-left font-semibold text-gray-800 hover:text-[#2a61ba]">
                      <span className="text-gray-400" aria-hidden="true">{expanded ? '▼' : '▶'}</span>
                      <span>{name}</span>
                      {!isTeacherAdmin && <span className="text-sm font-normal text-gray-500">({groupProblems.length} problems)</span>}
                    </button>
                  </div>
                  <div id={panelId} hidden={!expanded} className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-left"><tr>
                        {!isTeacherAdmin && <th className="px-4 py-3 w-10"><span className="sr-only">Select</span></th>}
                        {!isTeacherAdmin && <th className="px-4 py-3">Question</th>}
                        {!isTeacherAdmin && <th className="px-4 py-3">Answer</th>}
                        {!isTeacherAdmin && <th className="px-4 py-3">Source</th>}
                        <th className="px-4 py-3">Year</th>
                        <th className="px-4 py-3">Level</th>
                        <th className="px-4 py-3">Round</th>
                        <th className="px-4 py-3">Number</th>
                        <th className="px-4 py-3">Elo</th>
                        {!isTeacherAdmin && <th className="px-4 py-3">Actions</th>}
                      </tr></thead>
                      <tbody>{groupProblems.map(problem => {
                        const metadata = getCatalogMetadata(problem, DEMO_MODE);
                        return <tr key={problem.id} className="border-t">
                          {!isTeacherAdmin && <td className="px-4 py-3"><input type="checkbox" checked={selectedProblemIds.includes(problem.id)} onChange={event => setSelectedProblemIds(previous => event.target.checked ? [...new Set([...previous, problem.id])] : previous.filter(id => id !== problem.id))} aria-label={`Select problem ${problem.id}`} className="rounded" /></td>}
                          {!isTeacherAdmin && <td className="px-4 py-3 max-w-md"><LatexRenderer text={problem.question} />{problem.image_url && <ProblemImage url={problem.image_url} token={token} />}</td>}
                          {!isTeacherAdmin && <td className="px-4 py-3">{problem.answer}</td>}
                          {!isTeacherAdmin && <td className="px-4 py-3">{problem.source ?? '—'}</td>}
                          <td className="px-4 py-3">{metadata.year || '—'}</td>
                          <td className="px-4 py-3">{metadata.level || '—'}</td>
                          <td className="px-4 py-3">{metadata.round || '—'}</td>
                          <td className="px-4 py-3">{metadata.number || '—'}{isTeacherAdmin && <a href={`/problems/${problem.id}`} onClick={event => { event.preventDefault(); openProblemView(problem.id); }} className="ml-3 text-[#2a61ba] hover:underline font-medium">See problem</a>}</td>
                          <td className="px-4 py-3">{metadata.elo}</td>
                          {!isTeacherAdmin && <td className="px-4 py-3 space-x-2 whitespace-nowrap">
                            <a href={`/problems/${problem.id}`} onClick={event => { event.preventDefault(); openProblemView(problem.id); }} className="text-[#2a61ba] hover:underline font-medium">See problem</a>
                            <button type="button" onClick={() => setEditingProblem({ ...problem, image_url: problem.image_url ?? '', source: problem.source ?? '', year: problem.year ?? '', level: problem.level ?? '', round: problem.round ?? '', problem_number: problem.problem_number ?? '', folder_id: problem.folder_id ?? null })} className="text-[#2a61ba] hover:underline font-medium">Edit</button>
                            <button type="button" onClick={() => setProblemToDelete(problem.id)} className="text-red-600 hover:underline font-medium">Delete</button>
                          </td>}
                        </tr>;
                      })}</tbody>
                    </table>
                  </div>
                </section>
              );
            });
          })()}
          </div>
        </section>
      </div>
    </div>
  );
}


return (
  <div className="min-h-screen bg-[#f1f6fd] flex items-center justify-center text-gray-500">
    Loading…
  </div>
);

};

export default App;
