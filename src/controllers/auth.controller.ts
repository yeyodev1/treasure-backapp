import { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { User } from "../models/user.model";
import { badRequest, unauthorized } from "../errors/httpError";

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) throw badRequest("Correo y contraseña son obligatorios");

    const user = await User.findOne({ email: email.toLowerCase().trim(), active: true });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw unauthorized("Credenciales incorrectas");
    }

    const token = jwt.sign(
      { sub: user._id.toString(), name: user.name, role: user.role },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions,
    );

    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.auth!.sub).select("name email role active");
    if (!user) throw unauthorized();
    res.json({ user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
}
