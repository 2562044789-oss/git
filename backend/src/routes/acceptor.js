// 接单员域（用户侧）：实名认证申请 / 缴纳保证金 / 退出接单员。
// 从 server.js 的 handleApi 按业务领域拆出，行为完全不变，只是换了位置。
const { get, now, run, transaction } = require("../db");
const {
  HttpError,
  enforceRateLimit,
  ok,
  optionalText,
  parseBody,
  requireValue,
} = require("../http");
const {
  ACCEPTOR_STATUS,
  DEPOSIT_STATUS,
  ORDER_STATUS,
  WALLET_TYPE,
  isAcceptorActive,
} = require("../status");
const { acceptorView } = require("../views");

module.exports = async function handleAcceptor(req, res, url, ctx) {
  const {
    method,
    pathname,
    identity,
    readIdCardNo,
    readPhoneNumber,
    findAcceptorProfile,
    acceptorGate,
    changeBalance,
    createMessage,
    logOperation,
    ACCEPTOR_DEPOSIT_AMOUNT,
  } = ctx;

  // 查询自己的接单员认证状态。未提交过申请时同样返回 200（status = 0），
  // 让前端不必区分"没有记录"和"状态是未认证"两种情况。
  if (method === "GET" && pathname === "/api/acceptor/profile") {
    const gate = acceptorGate(identity.id);
    ok(res, {
      ...gate.summary,
      profile: acceptorView(gate.profile),
    });
    return true;
  }

  // 提交 / 重新提交实名认证申请
  if (method === "POST" && pathname === "/api/acceptor/apply") {
    enforceRateLimit(req, "acceptor-apply", 10);
    const userId = Number(identity.id);
    const body = await parseBody(req);
    const realName = optionalText(body.realName, 32);
    requireValue(/^[\u4e00-\u9fa5·]{2,32}$/.test(realName), "真实姓名需填写 2 个字以上的中文姓名");
    const idCardNo = readIdCardNo(body.idCardNo);
    const phone = readPhoneNumber(body.phone, "联系手机号");
    const idCardFront = optionalText(body.idCardFront, 255);
    const idCardBack = optionalText(body.idCardBack, 255);
    requireValue(
      Boolean(idCardFront && idCardBack),
      "请上传身份证正面与反面照片，用于管理员核验",
    );
    const emergencyContact = optionalText(body.emergencyContact, 64);
    const current = findAcceptorProfile(userId);
    if (current) {
      const status = Number(current.status);
      if (status === ACCEPTOR_STATUS.ACTIVE) {
        throw new HttpError(409, "你已通过接单员认证，无需重复提交");
      }
      if (status === ACCEPTOR_STATUS.REVIEWING) {
        throw new HttpError(409, "实名认证正在审核中，请等待审核结果");
      }
    }
    // 同一身份证号只允许绑定一个账号：防止同一人开多个接单账号刷单、规避保证金
    const occupied = get("SELECT user_id FROM acceptor_profiles WHERE id_card_no = ?", [idCardNo]);
    if (occupied && Number(occupied.user_id) !== userId) {
      throw new HttpError(409, "该身份证号已绑定其他账号，如有疑问请联系社区管理员");
    }
    const user = get("SELECT nickname, community FROM users WHERE id = ?", [userId]);
    transaction(() => {
      if (current) {
        // 重新提交时清空上一次的审核结论与保证金状态
        run(
          `UPDATE acceptor_profiles SET
            real_name = ?, id_card_no = ?, id_card_front = ?, id_card_back = ?, phone = ?,
            community = ?, emergency_contact = ?, status = ?, review_note = '',
            reviewed_by = NULL, reviewed_at = NULL,
            deposit_amount = ?, deposit_status = ?, deposit_paid_at = NULL, deposit_refunded_at = NULL,
            applied_at = ?, updated_at = ?
           WHERE user_id = ?`,
          [
            realName,
            idCardNo,
            idCardFront,
            idCardBack,
            phone,
            optionalText(body.community, 100) || user?.community || "",
            emergencyContact,
            ACCEPTOR_STATUS.REVIEWING,
            ACCEPTOR_DEPOSIT_AMOUNT,
            DEPOSIT_STATUS.UNPAID,
            now(),
            now(),
            userId,
          ],
        );
      } else {
        run(
          `INSERT INTO acceptor_profiles
            (user_id, real_name, id_card_no, id_card_front, id_card_back, phone, community,
             emergency_contact, status, deposit_amount, deposit_status, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            userId,
            realName,
            idCardNo,
            idCardFront,
            idCardBack,
            phone,
            optionalText(body.community, 100) || user?.community || "",
            emergencyContact,
            ACCEPTOR_STATUS.REVIEWING,
            ACCEPTOR_DEPOSIT_AMOUNT,
            DEPOSIT_STATUS.UNPAID,
            now(),
          ],
        );
      }
      createMessage(
        userId,
        "接单员认证已提交",
        `实名认证资料已提交，管理员审核通过后缴纳 ¥${ACCEPTOR_DEPOSIT_AMOUNT.toFixed(2)} 保证金即可开始接单。`,
        1,
      );
    });
    logOperation(identity, "submit_acceptor_apply", "acceptor", userId, `实名 ${realName}`, req);
    const gate = acceptorGate(userId);
    ok(
      res,
      { ...gate.summary, profile: acceptorView(gate.profile) },
      "认证资料已提交，请等待管理员审核",
    );
    return true;
  }

  // 缴纳保证金：从钱包余额扣除，钱进入平台托管，状态变为可接单
  if (method === "POST" && pathname === "/api/acceptor/deposit") {
    enforceRateLimit(req, "acceptor-deposit", 10);
    const userId = Number(identity.id);
    const current = findAcceptorProfile(userId);
    if (!current) throw new HttpError(409, "请先提交接单员实名认证申请");
    const currentStatus = Number(current.status);
    if (currentStatus === ACCEPTOR_STATUS.REVIEWING) {
      throw new HttpError(409, "实名认证正在审核中，通过后即可缴纳保证金");
    }
    if (currentStatus === ACCEPTOR_STATUS.REJECTED) {
      throw new HttpError(409, "实名认证未通过，请修改资料后重新提交");
    }
    if (isAcceptorActive(current)) {
      throw new HttpError(409, "你已缴纳保证金，无需重复缴纳");
    }
    let paid = 0;
    transaction(() => {
      // 事务内重新读取，避免与管理员审核、并发点击产生竞态
      const fresh = get("SELECT * FROM acceptor_profiles WHERE user_id = ?", [userId]);
      // 状态冲突统一返回 409（资源当前状态不允许该操作），
      // 与入参格式错误（400）区分开，前端才能给出不同的引导文案
      if (Number(fresh?.status) !== ACCEPTOR_STATUS.APPROVED) {
        throw new HttpError(409, "当前状态不能缴纳保证金，请先确认实名认证已通过");
      }
      if (Number(fresh.deposit_status) === DEPOSIT_STATUS.HELD) {
        throw new HttpError(409, "保证金已在托管中，无需重复缴纳");
      }
      const amount = ACCEPTOR_DEPOSIT_AMOUNT;
      const user = get("SELECT balance FROM users WHERE id = ?", [userId]);
      requireValue(
        Number(user.balance) >= amount,
        `保证金需 ¥${amount.toFixed(2)}，当前余额不足，请先充值`,
      );
      paid = changeBalance(
        userId,
        -amount,
        null,
        WALLET_TYPE.DEPOSIT,
        `接单员保证金缴纳 ¥${amount.toFixed(2)}`,
      );
      run(
        `UPDATE acceptor_profiles SET
          status = ?, deposit_amount = ?, deposit_status = ?, deposit_paid_at = ?, updated_at = ?
         WHERE user_id = ?`,
        [ACCEPTOR_STATUS.ACTIVE, amount, DEPOSIT_STATUS.HELD, now(), now(), userId],
      );
      createMessage(
        userId,
        "接单员认证已完成",
        `保证金 ¥${amount.toFixed(2)} 已缴纳，你现在可以在任务大厅接单了。`,
        1,
      );
    });
    logOperation(
      identity,
      "pay_acceptor_deposit",
      "acceptor",
      current.id,
      `¥${ACCEPTOR_DEPOSIT_AMOUNT}`,
      req,
    );
    const gate = acceptorGate(userId);
    ok(
      res,
      { ...gate.summary, balance: paid, profile: acceptorView(gate.profile) },
      "保证金已缴纳，你现在可以接单了",
    );
    return true;
  }

  // 退出接单员并退还保证金。
  // 前置条件：保证金确实处于托管中、且没有进行中的订单——
  // 否则会出现"退了钱却还有在途责任"的死角。
  if (method === "POST" && pathname === "/api/acceptor/quit") {
    enforceRateLimit(req, "acceptor-quit", 10);
    const userId = Number(identity.id);
    const current = findAcceptorProfile(userId);
    if (!isAcceptorActive(current)) {
      throw new HttpError(409, "你当前不是已认证的接单员");
    }
    const inFlight = get(
      "SELECT COUNT(*) AS total FROM orders WHERE acceptor_id = ? AND status IN (?, ?)",
      [userId, ORDER_STATUS.ACCEPTED, ORDER_STATUS.IN_SERVICE],
    ).total;
    if (Number(inFlight) > 0) {
      throw new HttpError(
        409,
        `你还有 ${inFlight} 个进行中的订单，请先完成后再退出接单员`,
      );
    }
    let refunded = 0;
    transaction(() => {
      const fresh = get("SELECT * FROM acceptor_profiles WHERE user_id = ?", [userId]);
      if (!isAcceptorActive(fresh)) {
        throw new HttpError(409, "你当前不是已认证的接单员");
      }
      const amount = Number(fresh.deposit_amount || 0);
      if (amount > 0) {
        refunded = changeBalance(
          userId,
          amount,
          null,
          WALLET_TYPE.DEPOSIT_REFUND,
          `接单员保证金退还 ¥${amount.toFixed(2)}`,
        );
      }
      run(
        `UPDATE acceptor_profiles SET
          status = ?, deposit_status = ?, deposit_refunded_at = ?, updated_at = ?
         WHERE user_id = ?`,
        [ACCEPTOR_STATUS.QUIT, DEPOSIT_STATUS.REFUNDED, now(), now(), userId],
      );
      createMessage(
        userId,
        "已退出接单员",
        amount > 0
          ? `保证金 ¥${amount.toFixed(2)} 已退回你的钱包余额，再次接单需重新完成认证。`
          : "你已退出接单员，再次接单需重新完成认证。",
        1,
      );
    });
    logOperation(identity, "quit_acceptor", "acceptor", current.id, "退出并退还保证金", req);
    const gate = acceptorGate(userId);
    ok(
      res,
      { ...gate.summary, balance: refunded, profile: acceptorView(gate.profile) },
      "已退出接单员，保证金已退回余额",
    );
    return true;
  }

  return false;
};
