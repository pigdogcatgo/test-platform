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
import PrototypeInsights from './components/PrototypeInsights';
import { PracticeHeader, FolioIntro } from './components/PracticeLayout';
import './index.css';

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';
const DEMO_TEACHER_USERNAME = import.meta.env.VITE_DEMO_TEACHER_USERNAME || 'demo-teacher';
const DEMO_STUDENT_USERNAME = import.meta.env.VITE_DEMO_STUDENT_USERNAME || 'demo-student';
const DEMO_TEACHER_PASSWORD = import.meta.env.VITE_DEMO_TEACHER_PASSWORD || 'teacher-preview-26';
const DEMO_STUDENT_PASSWORD = import.meta.env.VITE_DEMO_STUDENT_PASSWORD || 'student-preview-26';
const EMPTY_CATALOG_FILTERS = { search: '', topic: '', difficulty: '', roundType: '', yearFrom: '', yearTo: '' };
const DEMO_ROUND_TYPES = ['Sprint', 'Target', 'Practice'];

function getCatalogMetadata(problem, demoMode) {
  const source = typeof problem.source === 'string' ? problem.source : '';
  const yearFromSource = source.match(/\b(19\d{2}|20\d{2})\b/);
  const rawYearBlock = problem.year_block ?? problem.yearBlock;
  const yearBlock = typeof rawYearBlock === 'string' ? rawYearBlock : '';
  const yearRange = yearBlock.match(/\b(19\d{2}|20\d{2})\s*(?:-|–|—|to)\s*(19\d{2}|20\d{2})\b/i);
  const explicitYear = Number(problem.year ?? problem.source_year ?? problem.sourceYear ?? yearFromSource?.[0]);
  const id = Number(problem.id) || 0;
  const elo = Number(problem.elo);
  const topicValues = [...new Set([
    ...(Array.isArray(problem.tag_names) ? problem.tag_names : []),
    problem.topic,
  ].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  const difficultyLabels = ['Foundational', 'Developing', 'Intermediate', 'Advanced', 'Challenge'];
  const rawDifficulty = problem.difficulty;
  const difficulty = Number.isInteger(Number(rawDifficulty)) && Number(rawDifficulty) >= 1 && Number(rawDifficulty) <= 5
    ? difficultyLabels[Number(rawDifficulty) - 1]
    : typeof rawDifficulty === 'string' && rawDifficulty.trim()
      ? rawDifficulty.trim()
      : Number.isFinite(elo)
        ? elo < 1400 ? 'Foundational' : elo < 1600 ? 'Intermediate' : 'Advanced'
        : 'Unrated';
  const rawFormats = Array.isArray(problem.catalog_formats) ? problem.catalog_formats : [];
  const explicitRoundType = problem.round_type || problem.roundType || source.match(/\b(Sprint|Target|Practice)\b/i)?.[0];
  const roundTypes = [...new Set((rawFormats.length ? rawFormats : explicitRoundType ? [explicitRoundType] : [])
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim().replace(/\b\w/g, letter => letter.toUpperCase())))];
  if (roundTypes.length === 0) roundTypes.push(demoMode ? DEMO_ROUND_TYPES[id % DEMO_ROUND_TYPES.length] : 'Unspecified');
  let yearStart = yearRange ? Number(yearRange[1]) : Number.isInteger(explicitYear) && explicitYear >= 1900 && explicitYear <= 2100 ? explicitYear : null;
  let yearEnd = yearRange ? Number(yearRange[2]) : yearStart;
  if (yearStart == null && demoMode) yearStart = yearEnd = 2018 + (Math.abs(id) % 8);
  const yearLabel = yearBlock || (yearStart == null ? '' : yearStart === yearEnd ? String(yearStart) : `${yearStart}–${yearEnd}`);
  return {
    topics: topicValues.length ? topicValues : ['Other'],
    difficulty,
    roundTypes,
    yearStart,
    yearEnd,
    yearLabel,
  };
}

function getCatalogOptions(problems, demoMode) {
  const metadata = problems.map(problem => getCatalogMetadata(problem, demoMode));
  return {
    topics: [...new Set(metadata.flatMap(item => item.topics))].sort((a, b) => a.localeCompare(b)),
    difficulties: [...new Set(metadata.map(item => item.difficulty))].sort((a, b) => a.localeCompare(b)),
    roundTypes: [...new Set(metadata.flatMap(item => item.roundTypes).filter(value => value !== 'Unspecified'))].sort((a, b) => a.localeCompare(b)),
    years: [...new Set(metadata.flatMap(item => {
      if (!Number.isInteger(item.yearStart) || !Number.isInteger(item.yearEnd)) return [];
      const start = Math.max(1900, Math.min(item.yearStart, item.yearEnd));
      const end = Math.min(2100, Math.max(item.yearStart, item.yearEnd));
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }))].sort((a, b) => a - b),
  };
}

function filterCatalogProblems(problems, filters, demoMode) {
  const query = filters.search.trim().toLocaleLowerCase();
  const from = filters.yearFrom ? Number(filters.yearFrom) : null;
  const to = filters.yearTo ? Number(filters.yearTo) : null;
  return problems.filter(problem => {
    const metadata = getCatalogMetadata(problem, demoMode);
    const searchable = `${problem.question || ''} ${problem.source || ''} ${problem.topic || ''} ${(problem.tag_names || []).join(' ')} ${problem.folder_name || ''} ${metadata.difficulty} ${metadata.roundTypes.join(' ')} ${metadata.yearLabel}`.toLocaleLowerCase();
    if (query && !searchable.includes(query)) return false;
    if (filters.topic && !metadata.topics.includes(filters.topic)) return false;
    if (filters.difficulty && metadata.difficulty !== filters.difficulty) return false;
    if (filters.roundType && !metadata.roundTypes.includes(filters.roundType)) return false;
    if (from && (!metadata.yearEnd || metadata.yearEnd < from)) return false;
    if (to && (!metadata.yearStart || metadata.yearStart > to)) return false;
    return true;
  });
}

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
  const [testPdfUrl, setTestPdfUrl] = useState(null);
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
  const [pdfImportPreviewUrl, setPdfImportPreviewUrl] = useState(null);
  const [pdfImportPreviewError, setPdfImportPreviewError] = useState('');
  const [pdfImportFinalPdfReviewed, setPdfImportFinalPdfReviewed] = useState(false);
  const [pdfImportUseAI, setPdfImportUseAI] = useState(false);
  const [pdfImportUseImageMode, setPdfImportUseImageMode] = useState(false);
  const [pdfImportRunVerification, setPdfImportRunVerification] = useState(true);
  const [pdfImportReview, setPdfImportReview] = useState(null);
  const [pdfImportSourceTitle, setPdfImportSourceTitle] = useState('');
  const [pdfImportSourceUrl, setPdfImportSourceUrl] = useState('');
  const [pdfImportLicenseBasis, setPdfImportLicenseBasis] = useState('');
  const [pdfImportLicenseName, setPdfImportLicenseName] = useState('');
  const [pdfImportPermissionReference, setPdfImportPermissionReference] = useState('');
  const [pdfImportRightsConfirmed, setPdfImportRightsConfirmed] = useState(false);
  const [pdfImportStudentPagesConfirmed, setPdfImportStudentPagesConfirmed] = useState(false);
  const [pdfImportGeminiConsent, setPdfImportGeminiConsent] = useState(false);
  const [pdfImportAiRightsConfirmed, setPdfImportAiRightsConfirmed] = useState(false);
  const [newTest, setNewTest] = useState({ name: '', problemIds: [], dueDate: '', timeLimit: 30, testType: 'sprint', showSourcePdf: false });
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

  const catalogOptions = useMemo(() => getCatalogOptions(problems, DEMO_MODE), [problems]);
  const visibleCatalogProblems = useMemo(
    () => filterCatalogProblems(problems, catalogFilters, DEMO_MODE),
    [problems, catalogFilters]
  );
  const hasCatalogFilters = Object.values(catalogFilters).some(Boolean);

  const selectedProblemsForTest = newTest.problemIds
    .map(problemId => problems.find(problem => problem.id === problemId))
    .filter(Boolean);
  const selectedPdfDocumentIds = [...new Set(selectedProblemsForTest
    .map(problem => problem.pdf_document_id ?? problem.source_document_id ?? problem.pdfDocumentId ?? problem.sourceDocumentId)
    .filter(id => id !== null && id !== undefined)
    .map(String))];
  const selectedPdfDocumentId = selectedPdfDocumentIds.length === 1 &&
    selectedProblemsForTest.length === newTest.problemIds.length &&
    selectedProblemsForTest.every(problem => String(problem.pdf_document_id ?? problem.source_document_id ?? problem.pdfDocumentId ?? problem.sourceDocumentId) === selectedPdfDocumentIds[0])
    ? Number(selectedPdfDocumentIds[0])
    : null;

  const clearDashboardData = useCallback(() => {
    setProblems([]);
    setFolders([]);
    setTags([]);
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
    setTestPdfUrl(null);
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

  const loadTestPdf = useCallback(async (testId, problemList) => {
    const hasSourcePdf = problemList.some(problem =>
      problem.sourceDocumentId || problem.source_document_id || problem.pdfDocumentId || problem.pdf_document_id
    );
    if (!hasSourcePdf) return null;
    const { data } = await api.get(`/api/tests/${testId}/pdf`, { responseType: 'blob' });
    return URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
  }, [api]);

  useEffect(() => () => {
    if (testPdfUrl) URL.revokeObjectURL(testPdfUrl);
  }, [testPdfUrl]);

  useEffect(() => () => {
    if (pdfImportPreviewUrl) URL.revokeObjectURL(pdfImportPreviewUrl);
  }, [pdfImportPreviewUrl]);

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
    setTestPdfUrl(null);
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
      setTestPdfUrl(null);
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
        const pdfObjectUrl = await loadTestPdf(testId, probs);
        if (cancelled || !requestToken || localStorage.getItem('token') !== requestToken) {
          if (pdfObjectUrl) URL.revokeObjectURL(pdfObjectUrl);
          return;
        }
        const savedAnswers = sessionStorage.getItem('testAnswers_' + testId);
        const answers = savedAnswers ? JSON.parse(savedAnswers) : {};
        setActiveTest(test);
        setTestProblems(ordered.length ? ordered : probs);
        setTestPdfUrl(pdfObjectUrl);
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
  }, [user?.role, tests, api, view, activeTest, token, handleLogout, loadUserData, handleExpiredTest, loadTestPdf]);

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
      const pdfObjectUrl = await loadTestPdf(test.id, testProbs);
      if (!requestToken || localStorage.getItem('token') !== requestToken) {
        if (pdfObjectUrl) URL.revokeObjectURL(pdfObjectUrl);
        return;
      }
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
      setTestPdfUrl(pdfObjectUrl);
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
    if (newTest.showSourcePdf && !selectedPdfDocumentId) {
      setCreateTestError('A shared PDF test must use questions from one reviewed PDF source.');
      return;
    }

    setCreateTestError('');
    try {
      await api.post('/api/tests', {
        name: newTest.name,
        problemIds: newTest.problemIds,
        dueDate: newTest.dueDate,
        timeLimit: newTest.timeLimit,
        testType: newTest.testType,
        sourceDocumentId: newTest.showSourcePdf ? selectedPdfDocumentId : null
      });
      setNewTest({ name: '', problemIds: [], dueDate: '', timeLimit: 30, testType: 'sprint', showSourcePdf: false });
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
    if (!pdfImportSourceTitle.trim() || !pdfImportLicenseBasis) {
      alert('Enter the source title and select the license or permission basis for this PDF.');
      return;
    }
    if (pdfImportLicenseBasis === 'open_license' && !pdfImportLicenseName.trim()) {
      alert('Enter the name of the open license that permits this use.');
      return;
    }
    if (pdfImportLicenseBasis === 'written_permission' && !pdfImportPermissionReference.trim()) {
      alert('Add a reference or note for the written permission.');
      return;
    }
    if (!pdfImportRightsConfirmed || !pdfImportStudentPagesConfirmed) {
      alert('Confirm that you may use this PDF with your students and that the question pages contain no answer key or solutions.');
      return;
    }
    if (pdfImportUseAI && (!pdfImportGeminiConsent || !pdfImportAiRightsConfirmed)) {
      alert('Confirm Gemini processing and that the source rights permit sending this PDF and answer key to Google.');
      return;
    }
    setPdfImportLoading(true);
    setPdfImportResult(null);
    setPdfImportReview(null);
    setPdfImportPreviewUrl(null);
    try {
      const formData = new FormData();
      formData.append('pdf', pdfImportFile);
      formData.append('answerKey', pdfImportAnswerKey.trim());
      formData.append('useAI', pdfImportUseAI ? 'true' : 'false');
      formData.append('allowGeminiProcessing', pdfImportGeminiConsent ? 'true' : 'false');
      formData.append('useImageMode', pdfImportUseImageMode ? 'true' : 'false');
      formData.append('runVerification', pdfImportRunVerification ? 'true' : 'false');
      formData.append('sourceTitle', pdfImportSourceTitle.trim());
      formData.append('sourceUrl', pdfImportSourceUrl.trim());
      formData.append('licenseBasis', pdfImportLicenseBasis);
      formData.append('licenseName', pdfImportLicenseName.trim());
      formData.append('permissionReference', pdfImportPermissionReference.trim());
      formData.append('rightsConfirmed', pdfImportRightsConfirmed ? 'true' : 'false');
      formData.append('studentSafePagesConfirmed', pdfImportStudentPagesConfirmed ? 'true' : 'false');
      formData.append('aiRightsConfirmed', pdfImportAiRightsConfirmed ? 'true' : 'false');
      const { data } = await api.post('/api/import-pdf/start', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 300000,
      });
      setPdfImportReview(data);
      setPdfImportFile(null);
      setPdfImportAnswerKey('');
      setPdfImportGeminiConsent(false);
      setPdfImportAiRightsConfirmed(false);
      setPdfImportRightsConfirmed(false);
      setPdfImportStudentPagesConfirmed(false);
      const input = document.getElementById('pdf-import-input');
      if (input) input.value = '';
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
      if (accepted) {
        body.question = pdfImportReview.question;
        body.answer = pdfImportReview.answer;
        body.sourcePage = pdfImportReview.sourcePage;
      }
      const { data } = await api.post('/api/import-pdf/confirm', body);
      if (data.done) {
        setPdfImportResult(data);
        setPdfImportReview(null);
        setPdfImportPreviewUrl(null);
        setPdfImportPreviewError('');
        loadUserData({ preserveView: true });
      } else {
        if (data.awaitingStudentPdfApproval && data.importId) {
          setPdfImportReview(previous => ({ ...previous, ...data }));
          setPdfImportFinalPdfReviewed(false);
          setPdfImportPreviewError('');
          try {
            const { data: preview } = await api.get(`/api/import-pdf/${data.importId}/preview`, { responseType: 'blob' });
            setPdfImportPreviewUrl(URL.createObjectURL(new Blob([preview], { type: 'application/pdf' })));
          } catch (previewError) {
            setPdfImportPreviewError(previewError.response?.data?.error || 'Could not load the final PDF preview. Retry before approving it.');
          }
        } else {
          setPdfImportReview((prev) => ({ ...prev, ...data }));
        }
      }
    } catch (error) {
      setPdfImportResult({ error: error.response?.data?.error || error.message || 'Confirm failed' });
    } finally {
      setPdfImportLoading(false);
    }
  };

  const retryPdfImportPreview = async () => {
    if (!pdfImportReview?.importId) return;
    setPdfImportLoading(true);
    setPdfImportPreviewError('');
    try {
      const { data } = await api.get(`/api/import-pdf/${pdfImportReview.importId}/preview`, { responseType: 'blob' });
      setPdfImportPreviewUrl(URL.createObjectURL(new Blob([data], { type: 'application/pdf' })));
    } catch (error) {
      setPdfImportPreviewError(error.response?.data?.error || 'Could not load the final PDF preview. Retry before approving it.');
    } finally {
      setPdfImportLoading(false);
    }
  };

  const handlePdfImportFinalApproval = async (approved) => {
    if (!pdfImportReview?.importId) return;
    setPdfImportLoading(true);
    try {
      const { data } = await api.post('/api/import-pdf/confirm', {
        importId: pdfImportReview.importId,
        finalPdfApproved: approved,
      });
      setPdfImportPreviewUrl(null);
      setPdfImportPreviewError('');
      setPdfImportPreviewError('');
      if (!approved) {
        setPdfImportReview(null);
        setPdfImportFinalPdfReviewed(false);
        setPdfImportResult({ error: 'The PDF import was discarded. No questions or source PDF were saved.' });
      } else if (data.done) {
        setPdfImportResult(data);
        setPdfImportReview(null);
        setPdfImportFinalPdfReviewed(false);
        loadUserData({ preserveView: true });
      } else {
        setPdfImportReview(previous => ({ ...previous, ...data }));
      }
    } catch (error) {
      setPdfImportResult({ error: error.response?.data?.error || error.message || 'Final PDF review failed' });
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
        pdfUrl={testPdfUrl}
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

        <PracticeHeader audience="Student workspace" demoMode={DEMO_MODE} onLogout={handleLogout} />
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
            {user.tag_elos?.length > 0 && (
              <div className="inline-flex flex-col items-start bg-white border border-gray-200 px-4 py-3 rounded-xl">
                <span className="text-xs text-gray-600 mb-2">By Subject</span>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {user.tag_elos.map(t => (
                    <span key={t.name} className="text-gray-800">
                      {t.name}: <span className="font-semibold text-[#2a61ba]">{t.elo}</span>
                    </span>
                  ))}
                </div>
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
      <PracticeHeader audience="Teacher workspace" demoMode={DEMO_MODE} onLogout={handleLogout} />

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
            {selectedStudent.tag_elos?.length > 0 && (
              <div className="inline-flex flex-col items-start bg-white border border-gray-200 px-4 py-3 rounded-xl">
                <span className="text-xs text-gray-600 mb-2">By Subject</span>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {selectedStudent.tag_elos.map(t => (
                    <span key={t.name}>{t.name}: <span className="font-semibold text-[#2a61ba]">{t.elo}</span></span>
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
  const changeTestType = (type) => setNewTest(current => ({
    ...current,
    testType: type,
    problemIds: DEMO_MODE
      ? current.problemIds.filter(id => getCatalogMetadata(problems.find(problem => problem.id === id) || {}, true).roundTypes.includes(type === 'target' ? 'Target' : 'Sprint'))
      : current.problemIds,
  }));
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
                  <p className="text-sm text-gray-500 mt-0.5">30 problems, 1 point each. {DEMO_MODE ? 'Fictional demo scoring: 1× correct answers.' : 'Counts toward MATHCOUNTS score as 1× correct answers.'}</p>
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

          <ProblemCatalogFilters demoMode={DEMO_MODE} filters={catalogFilters} options={catalogOptions} onChange={setCatalogFilters} />

          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-gray-800">Choose problems</h2>
            <p className="text-sm text-gray-600" role="status" aria-live="polite">{newTest.problemIds.length} selected · {newTest.testType === 'target' ? '8' : '30'} required</p>
          </div>
          <p className="-mt-4 text-xs text-gray-600">
            Catalog filters change which items are shown; selected problem IDs remain in this test.
            {hiddenSelectedProblemCount > 0 && ` ${hiddenSelectedProblemCount} selected problem${hiddenSelectedProblemCount === 1 ? ' is' : 's are'} currently hidden by the filters.`}
          </p>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <label className={`flex items-start gap-3 text-sm ${selectedPdfDocumentId ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
              <input
                type="checkbox"
                checked={newTest.showSourcePdf}
                disabled={!selectedPdfDocumentId}
                onChange={event => setNewTest({ ...newTest, showSourcePdf: event.target.checked })}
                className="mt-1"
              />
              <span>
                <span className="block font-medium text-gray-800">Show one shared source PDF to students</span>
                <span className="mt-0.5 block text-gray-600">
                  {selectedPdfDocumentId
                    ? 'Students will see the reviewed question pages beside numbered answer fields. Each answer still updates its own problem ELO.'
                    : 'Select reviewed questions from the same imported PDF to enable the shared viewer.'}
                </span>
              </span>
            </label>
          </div>
          <div className="max-h-96 overflow-y-auto border rounded-lg p-4 space-y-1" role="region" aria-label="Problem selection">
            {(() => {
              const byFolder = {};
              for (const p of visibleCatalogProblems) {
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
                const requiredFormat = newTest.testType === 'target' ? 'Target' : 'Sprint';
                const folderIds = folderProbs
                  .filter(problem => !DEMO_MODE || getCatalogMetadata(problem, true).roundTypes.includes(requiredFormat))
                  .map(p => p.id);
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
                        {folderProbs.map(p => {
                    const metadata = getCatalogMetadata(p, DEMO_MODE);
                    const requiredFormat = newTest.testType === 'target' ? 'Target' : 'Sprint';
                    const formatCompatible = !DEMO_MODE || metadata.roundTypes.includes(requiredFormat);
                          return <label key={p.id} className="flex gap-3 text-sm items-center cursor-pointer hover:bg-gray-50 -mx-1 px-2 py-1.5 rounded">
                            <input
                              type="checkbox"
                              checked={newTest.problemIds.includes(p.id)}
                              disabled={!formatCompatible}
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
                              <span className="ml-2 text-gray-600">{metadata.difficulty} · {metadata.roundTypes.join(', ')}{metadata.yearLabel ? ` · ${metadata.yearLabel}` : ''}</span>
                              <span className="text-[#2a61ba] font-medium ml-2">ELO {p.elo}</span>
                              {!formatCompatible && <span className="ml-2 text-xs text-gray-500">Not available for {requiredFormat}</span>}
                            </span>
                          </label>
                        })}
                    </div>
                  </div>
                );
              });
            })()}
          </div>

          {visibleCatalogProblems.length === 0 && (
            <p className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600" role="status">No problems match these filters.</p>
          )}

          {createTestError && <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{createTestError}</p>}
          <button
            type="submit"
            disabled={newTest.problemIds.length !== (newTest.testType === 'target' ? 8 : 30) || !newTest.name.trim() || !newTest.dueDate || !Number.isInteger(Number(newTest.timeLimit)) || Number(newTest.timeLimit) < 1 || Number(newTest.timeLimit) > 240 || (newTest.showSourcePdf && !selectedPdfDocumentId)}
            className="w-full bg-[#2a61ba] hover:bg-[#20529f] disabled:cursor-not-allowed disabled:opacity-50 text-white py-3 rounded-lg font-medium"
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
                    <button type="button" onClick={() => updateFolder(f.id)} className="text-[#2a61ba] hover:underline text-xs">✓</button>
                    <button type="button" onClick={() => { setEditingFolderId(null); setEditingFolderName(''); }} className="text-gray-500 hover:underline text-xs">✗</button>
                  </>
                ) : (
                  <>
                    {f.name}
                    <button type="button" onClick={() => { setEditingFolderId(f.id); setEditingFolderName(f.name); }} className="text-[#2a61ba] hover:underline text-xs">edit</button>
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
            <button type="button" onClick={createFolder} className="px-4 py-2 bg-[#2a61ba] text-white rounded-lg text-sm">Add</button>
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
            Import only material you are authorized to store, process, and share with your students. Every extracted question and answer will be reviewed before it is saved. Pages containing embedded images require platform-admin approval for that exact PDF before processing, even when the rest of the file contains searchable text.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label htmlFor="pdf-source-title" className="mb-1 block text-xs font-medium text-gray-600">Source or publication title</label>
              <input id="pdf-source-title" maxLength={200} value={pdfImportSourceTitle} onChange={event => setPdfImportSourceTitle(event.target.value)} placeholder="Publication or material name" className="w-full rounded-lg border px-3 py-2 text-sm" />
            </div>
            <div>
              <label htmlFor="pdf-source-url" className="mb-1 block text-xs font-medium text-gray-600">Source link (optional)</label>
              <input id="pdf-source-url" type="url" maxLength={1000} value={pdfImportSourceUrl} onChange={event => setPdfImportSourceUrl(event.target.value)} placeholder="https://…" className="w-full rounded-lg border px-3 py-2 text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="pdf-license-basis" className="mb-1 block text-xs font-medium text-gray-600">License or permission basis</label>
              <select id="pdf-license-basis" value={pdfImportLicenseBasis} onChange={event => setPdfImportLicenseBasis(event.target.value)} className="w-full rounded-lg border bg-white px-3 py-2 text-sm">
                <option value="">Select the applicable basis</option>
                <option value="teacher_created">I created this material</option>
                <option value="open_license">The material has a license that permits this use</option>
                <option value="written_permission">I have written permission</option>
              </select>
            </div>
            {pdfImportLicenseBasis === 'open_license' && (
              <div className="sm:col-span-2">
                <label htmlFor="pdf-license-name" className="mb-1 block text-xs font-medium text-gray-600">Open license name</label>
                <input id="pdf-license-name" maxLength={200} value={pdfImportLicenseName} onChange={event => setPdfImportLicenseName(event.target.value)} placeholder="For example, Creative Commons license and version" className="w-full rounded-lg border px-3 py-2 text-sm" />
              </div>
            )}
            {pdfImportLicenseBasis === 'written_permission' && (
              <div className="sm:col-span-2">
                <label htmlFor="pdf-permission-reference" className="mb-1 block text-xs font-medium text-gray-600">Permission reference</label>
                <input id="pdf-permission-reference" maxLength={500} value={pdfImportPermissionReference} onChange={event => setPdfImportPermissionReference(event.target.value)} placeholder="Permission record, contact, or date" className="w-full rounded-lg border px-3 py-2 text-sm" />
              </div>
            )}
          </div>
          <label className="mb-3 flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={pdfImportRightsConfirmed} onChange={event => setPdfImportRightsConfirmed(event.target.checked)} className="mt-1" />
            <span>I have permission to upload and store this material, create individual question records from it, and show the approved question pages to my students.</span>
          </label>
          <label className="mb-3 flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={pdfImportStudentPagesConfirmed} onChange={event => setPdfImportStudentPagesConfirmed(event.target.checked)} className="mt-1" />
            <span>I have checked the question pages: they contain no answer key or solutions. Only pages with approved questions will be included in the student PDF.</span>
          </label>
          <label className="mb-3 flex items-start gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={pdfImportUseAI} onChange={event => {
              setPdfImportUseAI(event.target.checked);
              if (!event.target.checked) {
                setPdfImportGeminiConsent(false);
                setPdfImportAiRightsConfirmed(false);
                setPdfImportUseImageMode(false);
              }
            }} className="mt-1" />
            <span>Use Gemini to extract and format questions. The PDF and answer key will be sent to Google for processing; this requires source permission and server AI configuration.</span>
          </label>
          {pdfImportUseAI && (
            <div className="mb-3 space-y-2 text-sm text-gray-700">
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" checked={pdfImportGeminiConsent} onChange={event => setPdfImportGeminiConsent(event.target.checked)} className="mt-1" />
                <span>I consent to Gemini processing this PDF and answer key for this import.</span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" checked={pdfImportAiRightsConfirmed} onChange={event => setPdfImportAiRightsConfirmed(event.target.checked)} className="mt-1" />
                <span>The source license or permission allows sharing this material with Google for processing.</span>
              </label>
            </div>
          )}
          <label className={`flex items-center gap-2 mb-3 text-sm cursor-pointer ${!pdfImportUseAI ? 'opacity-60' : ''}`}>
            <input
              type="checkbox"
              checked={pdfImportUseImageMode}
              onChange={(e) => setPdfImportUseImageMode(e.target.checked)}
              disabled={!pdfImportUseAI}
            />
            Review problem crops from the PDF (preserves exact diagrams and layout)
          </label>
          <label className={`flex items-center gap-2 mb-3 text-sm cursor-pointer ${pdfImportUseImageMode || !pdfImportUseAI ? 'opacity-60' : ''}`}>
            <input
              type="checkbox"
              checked={pdfImportRunVerification}
              onChange={(e) => setPdfImportRunVerification(e.target.checked)}
              disabled={pdfImportUseImageMode || !pdfImportUseAI}
            />
            Run a second AI pass to check transcription
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
              className="px-4 py-2 bg-[#2a61ba] text-white rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
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
                  {pdfImportResult.sourceDocumentId && <span className="block mt-1">A private, question-pages-only PDF is ready. Select these problems when creating a test and turn on the shared PDF viewer.</span>}
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
            <AccessibleDialog ariaLabel={pdfImportReview.awaitingStudentPdfApproval ? 'Review student PDF' : `Review problem ${pdfImportReview.problemNumber}`} panelClassName="max-w-3xl p-6" closeOnBackdrop={false} closeOnEscape={false}>
              {pdfImportReview.awaitingStudentPdfApproval ? (
                <>
                  <h4 className="mb-2 text-lg font-bold">Review the student PDF</h4>
                  <p className="mb-2 text-sm text-gray-600">This is the exact question-pages-only PDF students will see. Check every page for answer keys or solutions before saving the import.</p>
                  {pdfImportReview.studentPageCount && <p className="mb-3 text-xs font-medium text-gray-600">{pdfImportReview.studentPageCount} student PDF page(s) · {pdfImportReview.reviewedQuestionCount} reviewed question(s)</p>}
                  {pdfImportPreviewUrl ? (
                    <iframe src={`${pdfImportPreviewUrl}#page=1&zoom=100`} title="Final student-safe PDF preview" className="mb-4 h-[65vh] min-h-[24rem] w-full rounded-lg border border-gray-300 bg-white" />
                  ) : pdfImportPreviewError ? (
                    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
                      <p>{pdfImportPreviewError}</p>
                      <button type="button" onClick={retryPdfImportPreview} disabled={pdfImportLoading} className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-2 font-semibold disabled:opacity-50">{pdfImportLoading ? 'Loading…' : 'Retry preview'}</button>
                    </div>
                  ) : (
                    <div className="mb-4 flex h-64 items-center justify-center rounded-lg border bg-gray-50 text-sm text-gray-600" role="status">Loading the student PDF preview…</div>
                  )}
                  <label className="mb-4 flex items-start gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={pdfImportFinalPdfReviewed} onChange={event => setPdfImportFinalPdfReviewed(event.target.checked)} className="mt-1" />
                    <span>I reviewed the exact student PDF and confirmed it contains no answer key or solutions.</span>
                  </label>
                  <div className="flex flex-wrap gap-3">
                    <button type="button" onClick={() => handlePdfImportFinalApproval(true)} disabled={pdfImportLoading || !pdfImportPreviewUrl || !pdfImportFinalPdfReviewed} className="rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                      {pdfImportLoading ? 'Saving…' : 'Approve PDF and save questions'}
                    </button>
                    <button type="button" onClick={() => handlePdfImportFinalApproval(false)} disabled={pdfImportLoading} className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-50">
                      Discard this import
                    </button>
                  </div>
                </>
              ) : (
                <>
                <h4 className="text-lg font-bold mb-2">
                  Problem {pdfImportReview.problemNumber} of {pdfImportReview.total}
                </h4>
                <p className="text-sm text-gray-600 mb-4">
                  Check the question, page, and answer. Fix any extraction errors before approving this problem.
                </p>
                {pdfImportReview.sourcePage && <p className="mb-2 text-xs font-medium text-gray-600">Source PDF page {pdfImportReview.sourcePage}</p>}
                {pdfImportReview.pageChanged && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">Page updated. Review the new preview before approving this question.</p>}
                <label className="mb-3 block text-sm font-medium text-gray-700">
                  Question page in the PDF
                  <input
                    type="number"
                    min="1"
                    max="60"
                    step="1"
                    value={pdfImportReview.sourcePage || ''}
                    onChange={event => setPdfImportReview(previous => ({ ...previous, sourcePage: event.target.value === '' ? '' : Number(event.target.value) }))}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal"
                    aria-label="Source PDF page for this problem"
                  />
                </label>
                {pdfImportReview.screenshot ? (
                  <img
                    key={`${pdfImportReview.problemIndex}-${pdfImportReview.reviewVersion ?? 0}`}
                    src={pdfImportReview.screenshot}
                    alt={`Source PDF crop for problem ${pdfImportReview.problemNumber}`}
                    className="w-full border rounded-lg mb-4 max-h-[50vh] object-contain bg-gray-50"
                  />
                ) : pdfImportReview.sourcePage ? (
                  <div className="w-full h-48 border rounded-lg mb-4 bg-gray-100 flex items-center justify-center text-gray-500">
                    Review the source PDF page and the extracted question below.
                  </div>
                ) : null}
                <label className="mb-3 block text-sm font-medium text-gray-700">
                  Extracted question
                  <textarea
                    value={pdfImportReview.question || ''}
                    onChange={event => setPdfImportReview(previous => ({ ...previous, question: event.target.value }))}
                    rows={4}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal"
                    aria-label="Edit extracted question"
                  />
                </label>
                <label className="mb-4 block text-sm font-medium text-gray-700">
                  Answer key for this problem
                  <input
                    type="text"
                    value={pdfImportReview.answer || ''}
                    onChange={event => setPdfImportReview(previous => ({ ...previous, answer: event.target.value }))}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal"
                    aria-label="Edit answer key for this problem"
                    autoComplete="off"
                  />
                </label>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => handlePdfImportConfirm(true)}
                    disabled={pdfImportLoading || !pdfImportReview.question?.trim() || !pdfImportReview.answer?.trim() || !Number.isInteger(Number(pdfImportReview.sourcePage)) || Number(pdfImportReview.sourcePage) < 1 || Number(pdfImportReview.sourcePage) > 60}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                  >
                    {pdfImportLoading ? 'Saving…' : 'Approve question and answer'}
                  </button>
                  {pdfImportUseAI && pdfImportUseImageMode && (
                    <>
                      <button
                        type="button"
                        onClick={() => handlePdfImportConfirm(false, 'up')}
                        disabled={pdfImportLoading || !pdfImportReview.screenshot}
                        className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                        title="Region should move up (include more from above)"
                      >
                        {pdfImportLoading ? '…' : 'No — move up'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePdfImportConfirm(false, 'down')}
                        disabled={pdfImportLoading || !pdfImportReview.screenshot}
                        className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                        title="Region should move down (include more from below)"
                      >
                        {pdfImportLoading ? '…' : 'No — move down'}
                      </button>
                    </>
                  )}
                </div>
                </>
              )}
            </AccessibleDialog>
          )}
        </div>

        <button
          onClick={() => setEditingProblem({ question: '', answer: '', topic: '', image_url: '', source: '', folder_id: null, tag_ids: [] })}
          className="mb-6 bg-[#2a61ba] text-white px-6 py-3 rounded-lg"
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
              className="px-3 py-1.5 bg-[#2a61ba] text-white rounded-lg text-sm hover:bg-[#20529f] disabled:opacity-50"
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
            for (const p of visibleCatalogProblems) {
              const fid = p.folder_id ?? UNCategorized;
              if (!byFolder[fid]) byFolder[fid] = { name: p.folder_name || 'Uncategorized', problems: [] };
              byFolder[fid].problems.push(p);
            }
            const folderIds = [...folders].sort((a, b) => a.name.localeCompare(b.name)).map(f => f.id);
            const orderedFolders = [
              ...folderIds,
              ...(byFolder[UNCategorized]?.problems?.length ? [UNCategorized] : [])
            ].filter(id => !hasCatalogFilters || byFolder[id]?.problems?.length > 0);
            if (orderedFolders.length === 0 && hasCatalogFilters) {
              return <div role="status" className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-600">No problems match these catalog filters.</div>;
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
              const isExpanded = hasCatalogFilters ? folderProbs.length > 0 : adminExpandedFolders.has(expandKey);
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
                      disabled={hasCatalogFilters}
                      aria-expanded={isExpanded}
                      aria-controls={folderPanelId}
                      className="flex items-center gap-2 text-left font-semibold text-gray-800 hover:text-[#2a61ba] disabled:cursor-default disabled:hover:text-gray-800"
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
                                  className="text-[#2a61ba] hover:underline font-medium"
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
  <div className="min-h-screen bg-[#f1f6fd] flex items-center justify-center text-gray-500">
    Loading…
  </div>
);

};

export default App;
