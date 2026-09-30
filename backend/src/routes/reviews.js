// 评价域：查询自己收到的评价。
// 从 server.js 的 handleApi 按业务领域拆出，行为完全不变，只是换了位置。
const { all } = require("../db");
const { ok } = require("../http");

module.exports = async function handleReviews(req, res, url, ctx) {
  const { method, pathname, identity } = ctx;

  if (method === "GET" && pathname === "/api/reviews") {
    ok(
      res,
      all(
        `SELECT r.*, u.nickname AS reviewer_name, t.title AS task_title
         FROM reviews r
         JOIN users u ON u.id = r.reviewer_id
         JOIN orders o ON o.id = r.order_id
         JOIN tasks t ON t.id = o.task_id
         WHERE r.reviewee_id = ?
         ORDER BY r.created_at DESC`,
        [identity.id],
      ),
    );
    return true;
  }

  return false;
};
