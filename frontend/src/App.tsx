import { Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { OperationsPage } from './pages/OperationsPage';
import { JobReviewPage } from './pages/JobReviewPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<OperationsPage />} />
      <Route path="/jobs/:jobId/review" element={<JobReviewPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
