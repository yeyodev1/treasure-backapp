import { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { IUser, User } from "../models/user.model";
import { badRequest, unauthorized } from "../errors/httpError";
import { Types } from "mongoose";

function signToken(user: IUser & { _id: Types.ObjectId }, remember: boolean): string {
  return jwt.sign(
    { sub: user._id.toString(), name: user.name, role: user.role, remember },
    env.JWT_SECRET,
    { expiresIn: remember ? env.JWT_REMEMBER_EXPIRES_IN : env.JWT_EXPIRES_IN } as jwt.SignOptions,
  );
}

function publicUser(user: IUser & { _id: Types.ObjectId }) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    isCashier: user.isCashier,
    position: user.position,
  };
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, remember } = req.body as {
      email?: string;
      password?: string;
      remember?: boolean;
    };
    if (!email || !password) throw badRequest("Correo y contraseña son obligatorios");

    const user = await User.findOne({ email: email.toLowerCase().trim(), active: true });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw unauthorized("Credenciales incorrectas");
    }

    res.json({ token: signToken(user, Boolean(remember)), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

export async function me(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.auth!.sub).select("name email role active isCashier position");
    if (!user || !user.active) throw unauthorized();
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

/**
 * Sesión deslizante: mientras la tableta se usa, el token se renueva con la
 * misma duración (12 h o 30 días) y el rol vigente del usuario.
 */
export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.auth!.sub).select("name email role active isCashier position");
    if (!user || !user.active) throw unauthorized();
    res.json({ token: signToken(user, Boolean(req.auth!.remember)), user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}
