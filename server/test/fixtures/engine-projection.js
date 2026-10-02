// Turns engine output into plain comparable JSON (drops the employee/account objects themselves,
// keeps their ids). Shared by the golden recorder and the parity test.

function projectCase(c) {
  const rating = Object.assign({}, c.rating, { primaryAccount: c.rating.primaryAccount ? c.rating.primaryAccount.id : null });
  return {
    id: c.employee.id, rating, eligibility: c.eligibility, learning: c.learning, cert: c.cert,
    workflowStep: c.workflow ? c.workflow.currentStep : null, risk: c.risk,
    ratingConfidence: c.ratingConfidence, promotionConfidence: c.promotionConfidence, achievement: c.achievement,
  };
}

function projectQuota(exceptions, overflowReason) {
  return exceptions.map((ex) => ({
    localGrade: ex.localGrade, quota: ex.quota, quotaPct: ex.quotaPct, gradeTotal: ex.gradeTotal, total: ex.total,
    ranked: ex.ranked.map((c) => c.employee.id),
    reasons: ex.ranked.map((c, i) => overflowReason(ex, i + 1, c)),
  }));
}

module.exports = { projectCase, projectQuota };
